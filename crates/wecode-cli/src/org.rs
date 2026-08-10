//! The default solo organisation.
//!
//! Defined in code for now; loading it from `org.toml` is the next step. What
//! matters already is that grants are *narrower than* the operator's, so the
//! delegation rule is exercised rather than assumed.

use wecode_gov::{ActionKind, Charter, Effective, Grant, Introspect, Invariant};

/// A seat in the org chart, and whoever currently occupies it.
#[derive(Clone, Debug)]
pub(crate) struct Post {
    pub(crate) name: &'static str,
    pub(crate) occupant: &'static str,
    pub(crate) role: &'static str,
    pub(crate) grant: Grant,
}

/// Charter invariants outrank every grant beneath them.
pub(crate) fn charter() -> Charter {
    Charter::with(vec![
        Invariant::NeverTouch(vec![
            ".github/**".into(),
            "infra/**".into(),
            "**/*.pem".into(),
            "**/*.key".into(),
        ]),
        Invariant::NeverRun(vec![
            "git push --force*".into(),
            "npm publish*".into(),
            "terraform apply*".into(),
            "rm -rf /*".into(),
        ]),
        Invariant::MaxTokens(1_000_000),
        Invariant::ApprovalToMerge(vec!["main".into(), "master".into(), "release/**".into()]),
    ])
}

pub(crate) fn posts() -> Vec<Post> {
    vec![
        Post {
            name: "impl-api",
            occupant: "claude-code",
            role: "engineer",
            grant: Grant::writer(&["crates/**", "src/**"])
                .with_read(&["**"])
                .with_run(&["cargo *", "npm test*"])
                .with_spend(200_000, 1800),
        },
        Post {
            // A tester that cannot edit the implementation cannot make a failing
            // test pass by weakening the code. Enforced, not requested.
            name: "test-api",
            occupant: "codex",
            role: "tester",
            grant: Grant::writer(&["tests/**"])
                .with_read(&["**"])
                .with_run(&["cargo test*"])
                .with_spend(50_000, 600),
        },
        Post {
            // A reviewer writes nothing at all, and is the only post that may
            // approve a merge.
            name: "review",
            occupant: "claude-code",
            role: "reviewer",
            grant: Grant::writer(&[])
                .with_read(&["**"])
                .with_run(&["git diff*", "cargo clippy*"])
                .with_spend(30_000, 300)
                .with_approve(&[ActionKind::Merge])
                .with_introspect(Introspect::Own),
        },
    ]
}

pub(crate) fn find(name: &str) -> Option<Post> {
    posts().into_iter().find(|p| p.name == name)
}

/// The grants bearing on one post: the post's own, intersected with anything the
/// assignment adds. An empty intersection permits nothing.
pub(crate) fn effective(post: &Post) -> Effective {
    Effective::of(vec![post.grant.clone()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_post_narrows_the_operator_grant() {
        let root = Grant::root();
        for p in posts() {
            assert!(
                p.grant.narrows(&root),
                "{} would escalate beyond the operator",
                p.name
            );
        }
    }

    #[test]
    fn the_tester_cannot_touch_implementation() {
        let t = find("test-api").expect("post exists");
        assert!(t.grant.allows_write("tests/cache.rs"));
        assert!(!t.grant.allows_write("crates/export/cache.rs"));
        assert!(!t.grant.allows_write("src/lib.rs"));
    }

    #[test]
    fn the_reviewer_writes_nothing() {
        let r = find("review").expect("post exists");
        assert!(!r.grant.allows_write("src/lib.rs"));
        assert!(!r.grant.allows_write("tests/a.rs"));
        assert!(r.grant.allows_read("src/lib.rs"));
    }

    #[test]
    fn only_the_reviewer_may_approve_a_merge() {
        let approvers: Vec<&str> = posts()
            .iter()
            .filter(|p| p.grant.approve.contains(&ActionKind::Merge))
            .map(|p| p.name)
            .collect();
        assert_eq!(approvers, vec!["review"]);
    }

    #[test]
    fn no_post_may_define_measures() {
        // The executor-never-defines rule: nobody below the operator holds Define.
        for p in posts() {
            assert!(p.grant.define.is_empty(), "{} may define measures", p.name);
        }
    }

    #[test]
    fn no_post_may_staff_or_reach_the_network() {
        for p in posts() {
            assert!(!p.grant.staff, "{} may staff", p.name);
            assert!(
                !p.grant.allows_host("example.com"),
                "{} has network",
                p.name
            );
        }
    }

    #[test]
    fn introspection_is_off_except_where_granted() {
        assert_eq!(find("impl-api").unwrap().grant.introspect, Introspect::None);
        assert_eq!(find("review").unwrap().grant.introspect, Introspect::Own);
    }

    #[test]
    fn unknown_post_is_none() {
        assert!(find("nope").is_none());
    }
}
