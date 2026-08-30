//! What one file defines, and what it names.
//!
//! Names, not symbols. Tree-sitter gives a concrete syntax tree and no idea what any
//! identifier refers to — resolution needs a compiler, and a compiler needs a resolved
//! dependency graph, which needs a fetch and usually a build, in a worktree whose whole
//! point is that nothing has been built in it yet. So what comes out of here is a list
//! of `(kind, name, line)` and the caller matches spellings.
//!
//! That is a heuristic, and everything downstream is shaped by admitting it: the map
//! ranks and never refuses. See [`crate::rank`] for what stops a shared spelling from
//! being read as evidence.
//!
//! The query is the grammar's own upstream `tags.scm`, compiled once per language and
//! kept. A file that does not parse still yields whatever the error-tolerant parse
//! found, which is the property that makes this usable on a tree mid-edit.

use std::sync::OnceLock;

use tree_sitter::{Node, Parser, Query, QueryCursor, QueryMatch, StreamingIterator};

use crate::Language;

/// Whether a name was written down here or merely mentioned.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TagKind {
    /// This file is where the name is introduced.
    Definition,
    /// This file names something introduced elsewhere — or elsewhere in itself.
    Reference,
}

impl TagKind {
    /// The single letter a cache entry records it as.
    #[must_use]
    pub fn mark(self) -> char {
        match self {
            Self::Definition => 'd',
            Self::Reference => 'r',
        }
    }

    /// The kind that letter names, for reading an entry back.
    #[must_use]
    pub fn of_mark(c: char) -> Option<Self> {
        match c {
            'd' => Some(Self::Definition),
            'r' => Some(Self::Reference),
            _ => None,
        }
    }
}

/// One name, as one file wrote it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Tag {
    pub kind: TagKind,
    pub name: String,
    /// One-based, as an editor counts.
    pub line: usize,
}

/// The most tags taken from one file.
///
/// A generated parser, a vendored bundle or a fixture of ten thousand rows is a file
/// whose names say nothing about the shape of anything, and reading all of them costs
/// the scan its incrementality on the one file that changes least often.
const TAG_CAP: usize = 4000;

/// The longest name kept. Beyond this it is a minified identifier or a generated
/// symbol, and matching on it would be matching on a checksum.
const NAME_CAP: usize = 128;

/// A compiled query and the capture indices it is read through.
struct Tagger {
    query: Query,
    /// The `@name` capture — the identifier itself.
    name: u32,
    /// What each capture index means, by that capture's own position. `None` for the
    /// captures a tag query carries for other readers: `@doc`, `@local.scope`.
    kinds: Vec<Option<TagKind>>,
}

impl Tagger {
    fn compile(lang: Language) -> Option<Self> {
        let query = Query::new(&lang.grammar(), &lang.tags_source().concat()).ok()?;
        let name = query.capture_index_for_name("name")?;
        // By prefix, because the convention is `definition.function`,
        // `reference.call`, `definition.method` — the half after the dot is the kind of
        // thing, and this only asks which side of the edge it is.
        let kinds = query
            .capture_names()
            .iter()
            .map(|n| {
                if n.starts_with("definition") {
                    Some(TagKind::Definition)
                } else if n.starts_with("reference") {
                    Some(TagKind::Reference)
                } else {
                    None
                }
            })
            .collect();
        Some(Self { query, name, kinds })
    }

    /// Which side of the edge a match is, from whichever of its captures says so.
    fn kind_of(&self, m: &QueryMatch<'_, '_>) -> Option<TagKind> {
        m.captures
            .iter()
            .find_map(|c| *self.kinds.get(usize::try_from(c.index).ok()?)?)
    }

    fn names<'m, 't>(&self, m: &'m QueryMatch<'_, 't>) -> impl Iterator<Item = Node<'t>> + 'm {
        let want = self.name;
        m.captures
            .iter()
            .filter(move |c| c.index == want)
            .map(|c| c.node)
    }
}

/// The compiled query for a language, or `None` when its `tags.scm` did not compile
/// against the grammar shipped beside it.
///
/// Compiled once and kept: a query is parsed and optimised at construction, and doing
/// that per file would cost more than the parse it serves. `None` is degradation and
/// not a panic — a grammar bump that broke one query would otherwise take down the scan
/// of every language.
fn tagger(lang: Language) -> Option<&'static Tagger> {
    static COMPILED: [OnceLock<Option<Tagger>>; Language::ALL.len()] =
        [const { OnceLock::new() }; Language::ALL.len()];
    COMPILED[lang.slot()]
        .get_or_init(|| Tagger::compile(lang))
        .as_ref()
}

/// Every name `source` defines or mentions, in the order they appear.
///
/// Empty when the language's query did not compile or the parser refused the input
/// outright. Never an error: a file the scan cannot read is a file that stays at the
/// file layer, and the caller counts it rather than stopping.
#[must_use]
pub fn tags(lang: Language, source: &[u8]) -> Vec<Tag> {
    let Some(t) = tagger(lang) else {
        return Vec::new();
    };
    let mut parser = Parser::new();
    if parser.set_language(&lang.grammar()).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&t.query, tree.root_node(), source);
    while let Some(m) = matches.next() {
        let Some(kind) = t.kind_of(m) else { continue };
        for node in t.names(m) {
            if out.len() >= TAG_CAP {
                return out;
            }
            let Ok(name) = node.utf8_text(source) else {
                continue;
            };
            if name.is_empty() || name.len() > NAME_CAP {
                continue;
            }
            out.push(Tag {
                kind,
                name: name.to_string(),
                line: node.start_position().row + 1,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(lang: Language, src: &str, kind: TagKind) -> Vec<String> {
        tags(lang, src.as_bytes())
            .into_iter()
            .filter(|t| t.kind == kind)
            .map(|t| t.name)
            .collect()
    }

    #[test]
    fn a_rust_file_yields_what_it_defines_and_what_it_calls() {
        let src = "struct Envelope;\nfn assemble() {\n    render();\n}\n";
        let found = tags(Language::Rust, src.as_bytes());
        let defs: Vec<(&str, usize)> = found
            .iter()
            .filter(|t| t.kind == TagKind::Definition)
            .map(|t| (t.name.as_str(), t.line))
            .collect();
        // Lines as an editor counts them, because the point of a line is that somebody
        // can go to it.
        assert_eq!(defs, vec![("Envelope", 1), ("assemble", 2)]);
        assert!(
            found
                .iter()
                .any(|t| t.kind == TagKind::Reference && t.name == "render"),
            "{found:?}"
        );
    }

    #[test]
    fn every_compiled_grammar_yields_a_definition_from_its_own_source() {
        // The whole set, in one test, because a grammar whose upstream query stopped
        // compiling degrades to silence: it yields nothing, and nothing about a thin
        // ranking says which of six grammars went quiet.
        let cases = [
            (Language::Rust, "fn seed_name() {}", "seed_name"),
            (Language::Python, "def seed_name():\n    pass\n", "seed_name"),
            (
                Language::TypeScript,
                "export function seedName(): void {}",
                "seedName",
            ),
            (
                Language::Tsx,
                "export function seedName() { return <div/>; }",
                "seedName",
            ),
            (Language::JavaScript, "function seedName() {}", "seedName"),
            (Language::Go, "package p\nfunc SeedName() {}\n", "SeedName"),
        ];
        for (lang, src, want) in cases {
            let defs = named(lang, src, TagKind::Definition);
            assert!(
                defs.iter().any(|d| d == want),
                "{}: wanted {want} in {defs:?}",
                lang.as_str()
            );
        }
    }

    #[test]
    fn a_file_that_does_not_compile_still_says_what_it_defines() {
        // The property tree-sitter is chosen for, and the reason a language server was
        // not: a worktree an agent is halfway through editing is exactly when somebody
        // wants to know what is next to what, and it is exactly when nothing builds.
        let src = "fn kept() {}\nfn broken( { ) unparseable\n";
        let defs = named(Language::Rust, src, TagKind::Definition);
        assert!(defs.contains(&"kept".to_string()), "{defs:?}");
    }

    #[test]
    fn a_comment_and_a_string_are_not_names() {
        // The reason this is not a regex. `docs/design/living-docs.md` already names
        // grep as the thing that has been fooled by exactly this.
        let src = "// fn ghost() {}\nfn real() { let s = \"fn phantom() {}\"; }\n";
        let defs = named(Language::Rust, src, TagKind::Definition);
        assert_eq!(defs, vec!["real".to_string()]);
    }

    #[test]
    fn an_empty_file_yields_nothing_rather_than_failing() {
        assert!(tags(Language::Rust, b"").is_empty());
        assert!(tags(Language::Go, b"").is_empty());
    }

    #[test]
    fn a_cache_mark_survives_being_written_down_and_read_back() {
        for kind in [TagKind::Definition, TagKind::Reference] {
            assert_eq!(TagKind::of_mark(kind.mark()), Some(kind));
        }
        assert_eq!(TagKind::of_mark('x'), None);
    }
}
