//! Which grammar reads a file, and what a language is called.
//!
//! A fixed set, compiled in. Loading grammars from disk at runtime would buy an
//! operator a language wecode has never heard of and cost a C compiler on every machine
//! that runs an agent, plus a grammar path to configure; wecode ships one binary, and
//! the set it supports has to be answerable at `project add` time against the
//! playbook's `language` field. So the degradation is per file and at runtime: an
//! extension no grammar claims is not an error, it is a file that stays at the file
//! layer — a path, a length, and its own first line, which is what every file had
//! before this existed.

use tree_sitter::Language as Grammar;

/// A language wecode has a grammar for.
///
/// TypeScript and TSX are two entries rather than one because they are two parsers:
/// the same source is ambiguous between them, and tree-sitter ships the pair for that
/// reason. They share one `tags.scm`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Language {
    Rust,
    Python,
    TypeScript,
    Tsx,
    JavaScript,
    Go,
}

impl Language {
    /// Every grammar compiled in, in the order a report lists them.
    pub const ALL: [Self; 6] = [
        Self::Rust,
        Self::Python,
        Self::TypeScript,
        Self::Tsx,
        Self::JavaScript,
        Self::Go,
    ];

    /// What it is called in a report and in a playbook.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Python => "python",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::JavaScript => "javascript",
            Self::Go => "go",
        }
    }

    /// The grammar that reads this path, by its extension.
    ///
    /// `None` is the ordinary answer for most of a repository — a markdown file, a
    /// lockfile, a PNG — and it is not a failure. The caller counts it and moves on.
    #[must_use]
    pub fn of_path(path: &str) -> Option<Self> {
        let ext = path.rsplit_once('.').map(|(_, e)| e)?;
        Some(match ext {
            "rs" => Self::Rust,
            "py" | "pyi" => Self::Python,
            "ts" | "mts" | "cts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            // JSX is the JavaScript grammar's own dialect, not a grammar of its own.
            "js" | "mjs" | "cjs" | "jsx" => Self::JavaScript,
            "go" => Self::Go,
            _ => return None,
        })
    }

    /// The grammar a written language name asks for, when one answers to it.
    ///
    /// What `wecode doctor` reads a playbook's `[project] language` with. Spellings
    /// rather than a parser: `go` and `golang` are the same request, and a project that
    /// wrote `Python` meant the one wecode has.
    #[must_use]
    pub fn named(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "rust" | "rs" => Some(Self::Rust),
            "python" | "py" | "python3" => Some(Self::Python),
            "typescript" | "ts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "javascript" | "js" | "node" | "nodejs" => Some(Self::JavaScript),
            "go" | "golang" => Some(Self::Go),
            _ => None,
        }
    }

    /// Its place in [`Self::ALL`] — the slot its compiled query is kept in.
    pub(crate) fn slot(self) -> usize {
        match self {
            Self::Rust => 0,
            Self::Python => 1,
            Self::TypeScript => 2,
            Self::Tsx => 3,
            Self::JavaScript => 4,
            Self::Go => 5,
        }
    }

    pub(crate) fn grammar(self) -> Grammar {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
        }
    }

    /// The upstream tag query shipped beside the grammar, in the order it composes.
    ///
    /// Data, not Rust. The `tags.scm` convention is maintained by whoever maintains the
    /// grammar and is what GitHub's code navigation reads; a query written here by hand
    /// would be a per-language debt that decays silently on the next grammar bump, and
    /// nothing would say it had.
    ///
    /// More than one source for TypeScript, because upstream's own file is a *delta*:
    /// it declares the type-level constructs and inherits the rest from ECMAScript.
    /// Concatenating in that order is the inheritance rule, not a query of wecode's —
    /// reading the file alone yields a language whose functions are invisible.
    pub(crate) fn tags_source(self) -> &'static [&'static str] {
        match self {
            Self::Rust => &[tree_sitter_rust::TAGS_QUERY],
            Self::Python => &[tree_sitter_python::TAGS_QUERY],
            Self::TypeScript | Self::Tsx => &[
                tree_sitter_javascript::TAGS_QUERY,
                tree_sitter_typescript::TAGS_QUERY,
            ],
            Self::JavaScript => &[tree_sitter_javascript::TAGS_QUERY],
            Self::Go => &[tree_sitter_go::TAGS_QUERY],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_read_by_the_grammar_its_extension_names() {
        assert_eq!(Language::of_path("crates/a/src/lib.rs"), Some(Language::Rust));
        assert_eq!(Language::of_path("app/main.go"), Some(Language::Go));
        assert_eq!(Language::of_path("web/App.tsx"), Some(Language::Tsx));
        assert_eq!(Language::of_path("web/api.ts"), Some(Language::TypeScript));
        // JSX is not a seventh grammar.
        assert_eq!(Language::of_path("web/App.jsx"), Some(Language::JavaScript));
    }

    #[test]
    fn a_file_no_grammar_claims_is_not_an_error() {
        // Most of a repository. The file layer already describes these, and a scan that
        // treated them as failures would report a tree of failures.
        for path in ["README.md", "Cargo.lock", "logo.png", "Makefile", ".gitignore"] {
            assert_eq!(Language::of_path(path), None, "{path}");
        }
    }

    #[test]
    fn a_language_a_playbook_names_is_read_however_it_is_spelled() {
        assert_eq!(Language::named("Rust"), Some(Language::Rust));
        assert_eq!(Language::named(" golang "), Some(Language::Go));
        assert_eq!(Language::named("node"), Some(Language::JavaScript));
        // What `wecode doctor` reports: wecode has no grammar for it.
        assert_eq!(Language::named("cobol"), None);
        assert_eq!(Language::named(""), None);
    }

    #[test]
    fn every_compiled_grammar_answers_to_its_own_name() {
        // The set `doctor` prints and the set `of_path` dispatches on are the same six,
        // and a name in one that the other does not know is how a language quietly
        // stops being mapped.
        for lang in Language::ALL {
            assert_eq!(Language::named(lang.as_str()), Some(lang), "{lang:?}");
        }
    }

    #[test]
    fn no_two_grammars_share_a_slot() {
        // The slots index a fixed array of compiled queries. Two languages answering
        // with the same number would hand one of them the other's query, and every tag
        // it produced would be wrong rather than missing.
        for (i, lang) in Language::ALL.iter().enumerate() {
            assert_eq!(lang.slot(), i, "{lang:?}");
        }
    }
}
