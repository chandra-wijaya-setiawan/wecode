//! `[agents.*]`, and the one number a seat writes beside it.
//!
//! One block per coding CLI: how to invoke it, what it may read out of the
//! environment, and — the line that needs hand-maintaining — which of its models is
//! stronger than which. The level a post asks for is here too, rather than beside the
//! post, because neither half decides anything alone: a level names no model until a
//! harness has declared a catalogue, and a catalogue is never indexed into until a
//! seat asks for a level.

use std::fmt;

use serde::Deserialize;

use super::{Company, OrgError, Post};

/// How clever the occupant of a seat should be, on a scale of 1 to 10.
///
/// A level, not a model name. Names churn and a chart pinned to one rots at the next
/// release; what is stable is *order* — which of a harness's models is stronger than
/// which — and that is what [`AgentTemplate::models`] declares. The number here is
/// matched against the scale derived from that list, so adding a model or reordering
/// one leaves every seat meaning roughly what it meant.
///
/// Held as tenths of a point rather than as an `f64`, for two reasons that both matter
/// here: config types in this file are compared for equality, which floats cannot do
/// honestly, and the index arithmetic in [`AgentTemplate::model_at`] is exact in
/// integers and a question of epsilons in floats. One decimal place is all the written
/// form ever needs — a four-model catalogue lands on 2.5, 5, 7.5 and 10.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Intelligence(i32);

impl Intelligence {
    /// The lowest level anything may be configured at.
    pub const MIN: Self = Self(10);
    /// The top of the scale, and what the strongest model in any catalogue answers to.
    pub const MAX: Self = Self(100);

    /// The level `n` points is, rounded to the tenth the written form carries.
    ///
    /// A level off the scale — `0`, `11`, `-3` — is *built* here rather than refused,
    /// which is also why the representation is signed. Refusing it in the deserialiser
    /// would report it at a TOML span; the check below refuses it naming the seat that
    /// wrote it, which is what whoever is editing the file is looking for.
    #[must_use]
    pub fn of(points: f64) -> Option<Self> {
        // Not a number, or wider than any scale could be: there is nothing to carry,
        // and a saturating cast would invent something.
        if !points.is_finite() || !(-1000.0..=1000.0).contains(&points) {
            return None;
        }
        #[expect(
            clippy::cast_possible_truncation,
            reason = "range-checked directly above, and rounded before the cast"
        )]
        Some(Self((points * 10.0).round() as i32))
    }

    /// Whether this is a level the scale actually has.
    #[must_use]
    pub fn in_range(self) -> bool {
        (Self::MIN..=Self::MAX).contains(&self)
    }

    /// The highest level the `i`th of `n` models answers to, counting from zero and
    /// weakest first.
    ///
    /// The scale is *spread* over the catalogue rather than written down per model:
    /// four entries give 2.5, 5, 7.5, 10. Hand-written levels would drift the moment a
    /// name changed; an order will not. Truncating rather than rounding is what keeps
    /// this the exact top of the band [`AgentTemplate::model_at`] selects — three
    /// entries answer up to 3.3, 6.6 and 10, and 6.7 is already the third.
    #[must_use]
    pub fn of_rank(i: usize, n: usize) -> Self {
        if n == 0 {
            return Self::MAX;
        }
        let i = i32::try_from(i.min(n - 1)).unwrap_or(0);
        let n = i32::try_from(n).unwrap_or(1);
        Self(Self::MAX.0 * (i + 1) / n)
    }

    /// The level as it was written, for a message a person reads.
    #[must_use]
    pub fn points(self) -> f64 {
        f64::from(self.0) / 10.0
    }
}

impl fmt::Display for Intelligence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // A whole number stays whole: `10`, not `10.0`, because that is how it was
        // written and this is read beside the file it came from.
        if self.0 % 10 == 0 {
            write!(f, "{}", self.0 / 10)
        } else {
            write!(f, "{}", self.points())
        }
    }
}

impl<'de> Deserialize<'de> for Intelligence {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let points = f64::deserialize(d)?;
        Self::of(points).ok_or_else(|| {
            serde::de::Error::custom(format!("intelligence must be a number, got {points}"))
        })
    }
}

/// How to invoke one coding CLI. Consumed by the execution layer.
#[derive(Clone, PartialEq, Eq, Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct AgentTemplate {
    pub command: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env_allowlist: Vec<String>,
    #[serde(default)]
    pub wall_secs: Option<u64>,
    #[serde(default)]
    pub idle_secs: Option<u64>,
    /// This harness's models, **weakest first**.
    ///
    /// The one line that needs hand-maintaining, and it is an ordering rather than a
    /// set of numbers — see [`Intelligence`] for why. Empty, which is the default,
    /// means wecode names no model and the harness runs whatever it would have run.
    #[serde(default)]
    pub models: Vec<String>,
    /// How this harness spells *use this model*.
    ///
    /// A field rather than a `{{model}}` placeholder in `args`, and the difference is
    /// the absent case: a placeholder the operator positions after their own `--model`
    /// would, when no level resolves, leave the flag standing with nothing behind it.
    /// Naming the flag lets both halves appear together or not at all.
    #[serde(default = "model_flag")]
    pub model_flag: String,
}

fn model_flag() -> String {
    "--model".to_string()
}

impl AgentTemplate {
    /// The model this level names, and `None` when this harness declared no catalogue.
    ///
    /// The weakest model whose derived level reaches the one asked for — so a seat at 5
    /// against `["haiku", "sonnet", "opus", "fable"]` gets `sonnet`, and a seat asking
    /// for more than the catalogue holds gets its best rather than nothing.
    #[must_use]
    pub fn model_at(&self, want: Intelligence) -> Option<&str> {
        let n = u32::try_from(self.models.len()).ok().filter(|n| *n > 0)?;
        // Integer arithmetic on tenths, and exact: `want` is the level, `n` models
        // divide the scale, so this is the first rank whose share of it reaches `want`.
        // Clamped to the scale first — a level off it is refused at load, and this
        // still has to answer with a model rather than an index nobody has.
        let want = want.clamp(Intelligence::MIN, Intelligence::MAX);
        #[expect(
            clippy::cast_sign_loss,
            reason = "clamped to the positive scale on the line above"
        )]
        let rank = ((want.0 as u32) * n)
            .div_ceil(Intelligence::MAX.0 as u32)
            .max(1)
            - 1;
        self.models
            .get(rank as usize)
            .or_else(|| self.models.last())
            .map(String::as_str)
    }
}

impl Company {
    /// The level this seat is staffed at.
    ///
    /// `max_intelligence` is deliberately absent here. A post above the ceiling is
    /// refused at load, so by the time anything asks this question the number has
    /// already been held to it — and clamping as well would be both an unreachable
    /// branch and the wrong repair, since a seat silently lowered is a file lying about
    /// what it staffs. The ceiling is a ceiling and not a default: a post under it
    /// keeps its own number, which is what stops this from being an elaborate way to
    /// spell "always use the best model".
    ///
    /// It exists as its own step because this is the single point of resolution — where
    /// a per-task override would land if one were built, and where the clamp would then
    /// belong, since a task is asked for rather than written down.
    #[must_use]
    pub fn intelligence_of(&self, post: &Post) -> Option<Intelligence> {
        post.intelligence
    }

    /// The model to launch this seat's harness with, and `None` for the harness default.
    ///
    /// `None` is the whole of the compatibility story: a seat with no level, a harness
    /// with no catalogue, or a post naming no agent at all each yield it, and a company
    /// that has never heard of any of this behaves exactly as it did before.
    #[must_use]
    pub fn model_for(&self, post: &Post) -> Option<&str> {
        self.agents
            .get(&post.agent)?
            .model_at(self.intelligence_of(post)?)
    }
}

/// What a catalogue and the levels pointed at it must satisfy.
///
/// Every failure here is a setting that reads as configured and decides nothing, which
/// is the one shape of wrong this file must not have. Run after [`super::chart::check`],
/// so a post naming an agent that does not exist is reported as the typo it is rather
/// than as a harness with no models.
pub(super) fn check(c: &Company) -> Result<(), OrgError> {
    if let Some(cap) = c.max_intelligence
        && !cap.in_range()
    {
        return Err(OrgError::BadValue {
            at: "[invariants] max_intelligence".into(),
            value: cap.to_string(),
        });
    }
    // A catalogue is checked before anything is indexed into it. A blank entry
    // would reach the harness as `--model ""`, and a blank flag as an empty
    // argument — both are a setting that reads as configured and launches wrong.
    for (name, agent) in &c.agents {
        if let Some(blank) = agent.models.iter().find(|m| m.trim().is_empty()) {
            return Err(OrgError::BadValue {
                at: format!("[agents.{name}] models"),
                value: blank.clone(),
            });
        }
        if !agent.models.is_empty() && agent.model_flag.trim().is_empty() {
            return Err(OrgError::BadValue {
                at: format!("[agents.{name}] model_flag"),
                value: agent.model_flag.clone(),
            });
        }
    }
    for post in &c.posts {
        let Some(want) = post.intelligence else {
            continue;
        };
        if !want.in_range() {
            return Err(OrgError::BadValue {
                at: format!("[[posts]] {} intelligence", post.name),
                value: want.to_string(),
            });
        }
        // The ceiling refuses the config rather than quietly lowering it: a post is
        // written by hand, and a number the file states and the run does not use is
        // the file lying about what it staffs.
        if let Some(cap) = c.max_intelligence
            && want > cap
        {
            return Err(OrgError::AboveCeiling {
                post: post.name.clone(),
                want,
                ceiling: cap,
            });
        }
        if !c
            .agents
            .get(&post.agent)
            .is_some_and(|a| !a.models.is_empty())
        {
            return Err(OrgError::UnrankedAgent {
                post: post.name.clone(),
                agent: post.agent.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::MINIMAL;

    /// The minimal company with a four-model catalogue on its harness, plus whatever
    /// top-level block the test wants after it.
    fn ranked(extra: &str) -> String {
        format!("{}\n{extra}", with_agent_line(MINIMAL, ATTRS))
    }

    const ATTRS: &str = "models = [\"haiku\", \"sonnet\", \"opus\", \"fable\"]";

    /// Adds lines to `[agents.claude-code]`, which is where they have to land: appended
    /// to the file they would join `[[posts]]` and be refused as unknown keys.
    fn with_agent_line(text: &str, line: &str) -> String {
        text.replace(
            "command = \"claude\"",
            &format!("command = \"claude\"\n{line}"),
        )
    }

    #[test]
    fn a_scale_is_spread_over_the_catalogue_rather_than_written_per_model() {
        // The whole reason a level is not a model name: four entries land on 2.5, 5,
        // 7.5, 10, and adding a fifth re-spreads them without any seat being edited.
        assert_eq!(Intelligence::of_rank(0, 4).to_string(), "2.5");
        assert_eq!(Intelligence::of_rank(1, 4).to_string(), "5");
        assert_eq!(Intelligence::of_rank(2, 4).to_string(), "7.5");
        assert_eq!(Intelligence::of_rank(3, 4).to_string(), "10");
        // Whatever the length, the strongest answers to the top of the scale.
        for n in 1..12 {
            assert_eq!(Intelligence::of_rank(n - 1, n), Intelligence::MAX, "n={n}");
        }
    }

    #[test]
    fn a_level_picks_the_weakest_model_that_reaches_it() {
        let c = Company::parse(&ranked("")).unwrap();
        let a = &c.agents["claude-code"];
        let at = |points: f64| a.model_at(Intelligence::of(points).unwrap()).unwrap();
        assert_eq!(at(1.0), "haiku");
        assert_eq!(at(2.5), "haiku", "the top of its band is still its band");
        assert_eq!(at(2.6), "sonnet", "and a tenth past it is the next one");
        assert_eq!(at(5.0), "sonnet");
        assert_eq!(at(7.5), "opus");
        assert_eq!(at(10.0), "fable");
    }

    #[test]
    fn a_harness_with_no_catalogue_names_no_model_at_all() {
        // The compatibility story, and the whole of it: this is what every company
        // that has never heard of the setting keeps doing.
        let c = Company::parse(MINIMAL).unwrap();
        let post = c.post("impl").unwrap();
        assert!(post.intelligence.is_none());
        assert_eq!(c.model_for(post), None);
        assert_eq!(
            c.agents["claude-code"].model_at(Intelligence::MAX),
            None,
            "an empty list has nothing to index into"
        );
        assert_eq!(
            c.agents["claude-code"].model_flag, "--model",
            "the flag most harnesses spell it with, so most need not say"
        );
    }

    #[test]
    fn a_seat_with_a_level_resolves_it_to_a_model() {
        let c = Company::parse(&ranked("").replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 7.5",
        ))
        .unwrap();
        let post = c.post("impl").unwrap();
        assert_eq!(c.intelligence_of(post), Intelligence::of(7.5));
        assert_eq!(c.model_for(post), Some("opus"));
    }

    #[test]
    fn an_integer_level_is_as_valid_as_a_decimal_one() {
        // TOML tells the two apart and a person writing `5` means the same thing.
        let c = Company::parse(&ranked("").replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 5",
        ))
        .unwrap();
        assert_eq!(c.model_for(c.post("impl").unwrap()), Some("sonnet"));
    }

    #[test]
    fn a_ceiling_is_a_ceiling_and_not_a_default() {
        // A seat under it keeps its own number. If the ceiling were also the default,
        // every task would run at the top of the scale and this would be an elaborate
        // way to spell "always use the best model".
        let text = ranked("[invariants]\nmax_intelligence = 10\n").replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 5",
        );
        let c = Company::parse(&text).unwrap();
        assert_eq!(c.max_intelligence, Intelligence::of(10.0));
        assert_eq!(c.model_for(c.post("impl").unwrap()), Some("sonnet"));
    }

    #[test]
    fn a_seat_configured_above_the_ceiling_is_refused_rather_than_lowered() {
        // A post is written by hand. A number the file states and the run does not use
        // is the file lying about what it staffs.
        let text = ranked("[invariants]\nmax_intelligence = 5\n").replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 10",
        );
        match Company::parse(&text).unwrap_err() {
            OrgError::AboveCeiling {
                post,
                want,
                ceiling,
            } => {
                assert_eq!(post, "impl");
                assert_eq!(want.to_string(), "10");
                assert_eq!(ceiling.to_string(), "5");
            }
            other => panic!("expected AboveCeiling, got {other}"),
        }
    }

    #[test]
    fn a_level_on_a_harness_with_no_models_is_refused_at_load() {
        // The failure this file refuses everywhere: a setting that reads as configured
        // and decides nothing. The message names the one line that repairs it.
        let text = MINIMAL.replace(
            "role = \"engineer\"",
            "role = \"engineer\"\nintelligence = 7.5",
        );
        match Company::parse(&text).unwrap_err() {
            OrgError::UnrankedAgent { post, agent } => {
                assert_eq!(post, "impl");
                assert_eq!(agent, "claude-code");
            }
            other => panic!("expected UnrankedAgent, got {other}"),
        }
    }

    #[test]
    fn a_level_off_the_scale_is_refused_by_the_seat_that_wrote_it() {
        for bad in ["0", "0.5", "11", "-3"] {
            let text = ranked("").replace(
                "role = \"engineer\"",
                &format!("role = \"engineer\"\nintelligence = {bad}"),
            );
            match Company::parse(&text).unwrap_err() {
                OrgError::BadValue { at, .. } => {
                    assert!(at.contains("impl"), "{at} should name the seat");
                    assert!(at.contains("intelligence"), "{at}");
                }
                other => panic!("expected BadValue for {bad}, got {other}"),
            }
        }
    }

    #[test]
    fn a_ceiling_off_the_scale_is_refused_too() {
        let text = ranked("[invariants]\nmax_intelligence = 25\n");
        match Company::parse(&text).unwrap_err() {
            OrgError::BadValue { at, value } => {
                assert!(at.contains("max_intelligence"), "{at}");
                assert_eq!(value, "25");
            }
            other => panic!("expected BadValue, got {other}"),
        }
    }

    #[test]
    fn a_catalogue_entry_that_would_launch_as_an_empty_argument_is_refused() {
        // `--model ""` is not a model, and neither is an empty flag. Both are settings
        // that parse and launch wrong.
        for (bad, at) in [
            ("models = [\"haiku\", \"\"]", "models"),
            ("models = [\"haiku\"]\nmodel_flag = \"  \"", "model_flag"),
        ] {
            match Company::parse(&with_agent_line(MINIMAL, bad)).unwrap_err() {
                OrgError::BadValue { at: got, .. } => assert!(got.contains(at), "{got}"),
                other => panic!("expected BadValue for {bad}, got {other}"),
            }
        }
    }
}
