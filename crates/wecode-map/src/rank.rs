//! Which files sit next to a scope, and how sure the map is about each of them.
//!
//! An edge is drawn by matching a spelling: this file mentions `refuse`, that file
//! defines `refuse`, so the two are near each other. Nothing here resolves anything,
//! and the whole design turns on saying so.
//!
//! **Rarity is the evidence.** `new`, `run`, `id` and `main` are defined in half the
//! files of any repository and mean nothing, so a name's weight is inverse to how many
//! files define it, and a name defined in more than [`NOISE_FLOOR`] of them is dropped
//! before it is counted rather than weighted down. A name defined once is the whole
//! signal; a name defined thirty times is a coincidence with a spelling.
//!
//! **One hop, and no centrality.** The ranking is inverse-frequency-weighted degree
//! from the seed set outward. Not PageRank: global centrality answers *which file does
//! this repository revolve around*, whose answer is `main.rs`, which the agent can
//! already see. The question here is local — what sits next to what I am about to
//! change — and the seed set is what makes it local.
//!
//! **It ranks; it never refuses.** Nothing here gates admission, and the vocabulary is
//! held to what the data supports: a row says *references* and *referenced by*, never
//! *depends on*, which is a claim about resolution that a matched spelling cannot make.

use std::collections::{BTreeMap, BTreeSet};

use crate::{Tag, TagKind};

/// How many files may define a name before it stops being evidence of anything.
///
/// A cliff rather than a slope, because the tail is where the noise is: a name in nine
/// files is not a weak signal, it is a word. Eight is above the count for a genuinely
/// shared concept in a workspace of a few crates and well below `new` or `run`.
const NOISE_FLOOR: usize = 8;

/// How many shared names a row lists before it says how many more there were. Enough
/// to see *why* a file was ranked; short enough that twenty rows are still a table.
const NAMES_SHOWN: usize = 4;

/// What one file wrote down, reduced to the two questions ranking asks of it.
///
/// Sets, not lists: a file that calls `refuse` forty times is no more coupled to the
/// file defining it than one that calls it once, and counting the calls would rank
/// loops.
struct Entry {
    path: String,
    defines: BTreeSet<String>,
    mentions: BTreeSet<String>,
}

/// Every file that was scanned, and the two name indexes over them.
#[derive(Default)]
pub struct Index {
    files: Vec<Entry>,
    /// Name to the files defining it — what a weight is computed from.
    defs: BTreeMap<String, BTreeSet<usize>>,
    /// Name to the files mentioning it. The same edge read from the other end, kept
    /// because a scope's *callers* are as much its neighbours as its callees.
    refs: BTreeMap<String, BTreeSet<usize>>,
}

impl std::fmt::Debug for Index {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Index")
            .field("files", &self.files.len())
            .field("names", &self.defs.len())
            .finish()
    }
}

impl Index {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Files with no tags at all are still inserted.
    ///
    /// A file the scan could read and found nothing in is a fact — it is what an
    /// interface file or a module of constants looks like — and dropping it would make
    /// the file count disagree with the tree.
    pub fn insert(&mut self, path: impl Into<String>, tags: &[Tag]) {
        let at = self.files.len();
        let mut entry = Entry {
            path: path.into(),
            defines: BTreeSet::new(),
            mentions: BTreeSet::new(),
        };
        for tag in tags {
            match tag.kind {
                TagKind::Definition => {
                    entry.defines.insert(tag.name.clone());
                    self.defs.entry(tag.name.clone()).or_default().insert(at);
                }
                TagKind::Reference => {
                    entry.mentions.insert(tag.name.clone());
                    self.refs.entry(tag.name.clone()).or_default().insert(at);
                }
            }
        }
        self.files.push(entry);
    }

    #[must_use]
    pub fn files(&self) -> usize {
        self.files.len()
    }

    #[must_use]
    pub fn names(&self) -> usize {
        self.defs.len()
    }

    /// Every path scanned, in the order it was inserted. What a caller resolves its own
    /// globs against — this crate knows no path conventions and matches none.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.files.iter().map(|f| f.path.as_str())
    }

    /// What a shared name is worth. Zero above [`NOISE_FLOOR`], so a common word costs
    /// nothing to carry and contributes no edge.
    fn weight(&self, name: &str) -> f64 {
        match self.defs.get(name).map(BTreeSet::len) {
            Some(n) if n > 0 && n <= NOISE_FLOOR => 1.0 / n as f64,
            _ => 0.0,
        }
    }

    /// Which scanned files a seed path set names. Paths, matched exactly — resolving a
    /// glob is the caller's, and this crate opens nothing and knows no conventions.
    fn seeded(&self, seeds: &[String]) -> BTreeSet<usize> {
        let wanted: BTreeSet<&str> = seeds.iter().map(String::as_str).collect();
        self.files
            .iter()
            .enumerate()
            .filter(|(_, f)| wanted.contains(f.path.as_str()))
            .map(|(i, _)| i)
            .collect()
    }
}

/// One neighbouring file, and the names that put it there.
#[derive(Clone, Debug)]
pub struct Ranked {
    pub path: String,
    pub score: f64,
    /// Names this file defines that the seeds mention — the seeds *reference* it.
    pub provides: Vec<String>,
    /// Names this file mentions that the seeds define — it *is referenced by* them.
    pub uses: Vec<String>,
    /// Shared names past the ones listed. Counted rather than dropped, for the reason
    /// `map.rs` counts what it leaves out: a list that stops quietly reads as one that
    /// ended.
    pub more: usize,
}

/// A ranking, and what did not fit in it.
#[derive(Debug)]
pub struct Ranking {
    pub rows: Vec<Ranked>,
    /// Files that scored above zero and were cut by the row budget.
    pub dropped: usize,
    /// Whether the seed set named nothing, so the rows answer *what does this
    /// repository name most* rather than *what sits next to this scope*. Two different
    /// questions, and a reader has to be told which one was answered.
    pub seeded: bool,
}

/// What is worth being reported about one file, before the budget is applied.
#[derive(Default)]
struct Score {
    total: f64,
    provides: BTreeMap<String, f64>,
    uses: BTreeMap<String, f64>,
}

impl Score {
    fn add(&mut self, weight: f64) {
        self.total += weight;
    }
}

/// The files nearest `seeds`, most tightly coupled first.
///
/// With no seed the question changes rather than disappearing: a task that declares no
/// write scope has no *there* to be near, so the rows become the files the rest of the
/// tree names most. Both are one hop and one weighting; only the starting set differs,
/// and [`Ranking::seeded`] says which was asked.
#[must_use]
pub fn rank(index: &Index, seeds: &[String], budget: usize) -> Ranking {
    let seeded = index.seeded(seeds);
    let scores = if seeded.is_empty() {
        named_most(index)
    } else {
        near(index, &seeded)
    };
    let mut ranked: Vec<Ranked> = scores
        .into_iter()
        .filter(|(_, s)| s.total > 0.0)
        .map(|(at, s)| row(&index.files[at].path, &s))
        .collect();

    // Score first, then path, so a tie does not reshuffle between two runs over the
    // same tree — an ordering that moves on its own is one nobody can compare.
    ranked.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.path.cmp(&b.path)));
    let dropped = ranked.len().saturating_sub(budget);
    ranked.truncate(budget);
    Ranking {
        rows: ranked,
        dropped,
        seeded: !seeded.is_empty(),
    }
}

/// One hop out of the seed set, both ways along the edge.
fn near(index: &Index, seeded: &BTreeSet<usize>) -> BTreeMap<usize, Score> {
    let mut out: BTreeMap<usize, Score> = BTreeMap::new();
    let mut wanted: BTreeSet<&str> = BTreeSet::new();
    let mut offered: BTreeSet<&str> = BTreeSet::new();
    for at in seeded {
        wanted.extend(index.files[*at].mentions.iter().map(String::as_str));
        offered.extend(index.files[*at].defines.iter().map(String::as_str));
    }

    // What the scope names, defined elsewhere.
    for name in wanted {
        let w = index.weight(name);
        if w <= 0.0 {
            continue;
        }
        for at in index.defs.get(name).into_iter().flatten() {
            if seeded.contains(at) {
                continue;
            }
            let s = out.entry(*at).or_default();
            s.add(w);
            s.provides.insert(name.to_string(), w);
        }
    }

    // What the scope defines, named elsewhere. The same edge from the other end: a
    // file about to change is as coupled to what calls it as to what it calls.
    for name in offered {
        let w = index.weight(name);
        if w <= 0.0 {
            continue;
        }
        for at in index.refs.get(name).into_iter().flatten() {
            if seeded.contains(at) {
                continue;
            }
            let s = out.entry(*at).or_default();
            s.add(w);
            s.uses.insert(name.to_string(), w);
        }
    }
    out
}

/// The files the rest of the tree names most — the answer when there is no scope to be
/// near. Weighted the same way, so a file that defines twenty common words does not
/// out-rank one that defines the name everything calls.
fn named_most(index: &Index) -> BTreeMap<usize, Score> {
    let mut out: BTreeMap<usize, Score> = BTreeMap::new();
    for (name, definers) in &index.defs {
        let w = index.weight(name);
        if w <= 0.0 {
            continue;
        }
        for at in definers {
            let callers = index
                .refs
                .get(name)
                .map(|r| r.iter().filter(|c| *c != at).count())
                .unwrap_or_default();
            if callers == 0 {
                continue;
            }
            let s = out.entry(*at).or_default();
            s.add(w * callers as f64);
            s.provides.insert(name.clone(), w);
        }
    }
    out
}

/// One row, with its rarest shared names named and the rest counted.
fn row(path: &str, s: &Score) -> Ranked {
    let shown = |m: &BTreeMap<String, f64>| -> Vec<String> {
        let mut v: Vec<(&String, &f64)> = m.iter().collect();
        v.sort_by(|a, b| b.1.total_cmp(a.1).then(a.0.cmp(b.0)));
        v.into_iter()
            .take(NAMES_SHOWN)
            .map(|(n, _)| n.clone())
            .collect()
    };
    let provides = shown(&s.provides);
    let uses = shown(&s.uses);
    Ranked {
        path: path.to_string(),
        score: s.total,
        more: (s.provides.len() - provides.len()) + (s.uses.len() - uses.len()),
        provides,
        uses,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(kind: TagKind, name: &str) -> Tag {
        Tag {
            kind,
            name: name.to_string(),
            line: 1,
        }
    }

    fn defines(names: &[&str]) -> Vec<Tag> {
        names.iter().map(|n| tag(TagKind::Definition, n)).collect()
    }

    fn mentions(names: &[&str]) -> Vec<Tag> {
        names.iter().map(|n| tag(TagKind::Reference, n)).collect()
    }

    fn index(files: &[(&str, Vec<Tag>)]) -> Index {
        let mut ix = Index::new();
        for (path, tags) in files {
            ix.insert(*path, tags);
        }
        ix
    }

    fn paths(r: &Ranking) -> Vec<&str> {
        r.rows.iter().map(|x| x.path.as_str()).collect()
    }

    #[test]
    fn the_file_defining_what_the_seed_calls_outranks_an_unrelated_one() {
        let ix = index(&[
            ("seed.rs", mentions(&["assemble_envelope"])),
            ("near.rs", defines(&["assemble_envelope"])),
            ("far.rs", defines(&["unrelated_thing", "another_thing"])),
        ]);
        let r = rank(&ix, &["seed.rs".to_string()], 10);
        assert_eq!(paths(&r), vec!["near.rs"]);
        assert!(r.seeded);
        assert_eq!(r.rows[0].provides, vec!["assemble_envelope".to_string()]);
    }

    #[test]
    fn a_name_defined_everywhere_contributes_no_edge() {
        // The heuristic's own failure mode, priced in: `new` is defined in every file
        // of every repository and says nothing about any of them.
        let mut files: Vec<(&str, Vec<Tag>)> = vec![("seed.rs", mentions(&["new", "refuse"]))];
        let common = [
            "a.rs", "b.rs", "c.rs", "d.rs", "e.rs", "f.rs", "g.rs", "h.rs", "i.rs",
        ];
        for p in common {
            files.push((p, defines(&["new"])));
        }
        files.push(("rare.rs", defines(&["refuse"])));
        let r = rank(&index(&files), &["seed.rs".to_string()], 20);
        assert_eq!(
            paths(&r),
            vec!["rare.rs"],
            "a name in {} files still scored",
            common.len()
        );
    }

    #[test]
    fn rarity_is_what_ranks_two_neighbours_apart() {
        let ix = index(&[
            ("seed.rs", mentions(&["shared", "unique"])),
            ("rare.rs", defines(&["unique"])),
            ("common.rs", defines(&["shared"])),
            ("also.rs", defines(&["shared"])),
            ("again.rs", defines(&["shared"])),
        ]);
        let r = rank(&ix, &["seed.rs".to_string()], 10);
        assert_eq!(paths(&r)[0], "rare.rs");
        assert!(r.rows[0].score > r.rows[1].score, "{:?}", r.rows);
    }

    #[test]
    fn a_seeds_callers_are_neighbours_too() {
        // One hop, both ways. A file about to be changed is as coupled to what calls
        // it as to what it calls, and a ranking that only followed the outward edge
        // would hide every caller of the function being edited.
        let ix = index(&[
            ("seed.rs", defines(&["assemble_envelope"])),
            ("caller.rs", mentions(&["assemble_envelope"])),
        ]);
        let r = rank(&ix, &["seed.rs".to_string()], 10);
        assert_eq!(paths(&r), vec!["caller.rs"]);
        assert_eq!(r.rows[0].uses, vec!["assemble_envelope".to_string()]);
        assert!(r.rows[0].provides.is_empty());
    }

    #[test]
    fn a_seed_never_ranks_itself() {
        // Two seeds that call each other are both already in the scope. Listing them
        // would spend the budget telling the agent about the files it named.
        let ix = index(&[
            ("a.rs", defines(&["one"])),
            ("b.rs", mentions(&["one"])),
            ("c.rs", mentions(&["one"])),
        ]);
        let seeds = vec!["a.rs".to_string(), "b.rs".to_string()];
        assert_eq!(paths(&rank(&ix, &seeds, 10)), vec!["c.rs"]);
    }

    #[test]
    fn with_no_seed_the_rows_are_what_the_tree_names_most() {
        // A task that declared no write scope has no *there* to be near. The question
        // changes, and `seeded` is what says so to whoever renders it.
        let ix = index(&[
            ("hub.rs", defines(&["central"])),
            ("a.rs", mentions(&["central"])),
            ("b.rs", mentions(&["central"])),
            ("quiet.rs", defines(&["nobody_calls_this"])),
        ]);
        let r = rank(&ix, &[], 10);
        assert_eq!(paths(&r), vec!["hub.rs"]);
        assert!(!r.seeded);
    }

    #[test]
    fn a_seed_path_nothing_scanned_falls_back_rather_than_ranking_nothing() {
        // A scope naming only markdown, or a directory of fixtures. An empty table
        // under a heading tells the reader the repository has no shape.
        let ix = index(&[
            ("hub.rs", defines(&["central"])),
            ("a.rs", mentions(&["central"])),
        ]);
        let r = rank(&ix, &["docs/plan.md".to_string()], 10);
        assert!(!r.seeded);
        assert_eq!(paths(&r), vec!["hub.rs"]);
    }

    #[test]
    fn what_the_budget_cuts_is_counted() {
        let mut files: Vec<(&str, Vec<Tag>)> = vec![("seed.rs", mentions(&["n0", "n1", "n2"]))];
        for i in 0..3 {
            files.push((["p0.rs", "p1.rs", "p2.rs"][i], defines(&[&format!("n{i}")])));
        }
        let owned: Vec<(&str, Vec<Tag>)> = files;
        let r = rank(&index(&owned), &["seed.rs".to_string()], 2);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.dropped, 1);
    }

    #[test]
    fn a_row_names_its_rarest_shared_names_and_counts_the_rest() {
        let shared: Vec<String> = (0..NAMES_SHOWN + 3).map(|i| format!("name{i}")).collect();
        let borrowed: Vec<&str> = shared.iter().map(String::as_str).collect();
        let ix = index(&[
            ("seed.rs", mentions(&borrowed)),
            ("near.rs", defines(&borrowed)),
        ]);
        let r = rank(&ix, &["seed.rs".to_string()], 10);
        assert_eq!(r.rows[0].provides.len(), NAMES_SHOWN);
        assert_eq!(r.rows[0].more, 3);
    }

    #[test]
    fn a_file_the_scan_found_nothing_in_is_still_a_file() {
        let mut ix = Index::new();
        ix.insert("empty.rs", &[]);
        assert_eq!(ix.files(), 1);
        assert_eq!(ix.names(), 0);
    }
}
