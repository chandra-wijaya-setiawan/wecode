//! The circuit breaker: what a seat spent in an hour, and the ceiling on it.
//!
//! A token budget is a figure per attempt. Three retries of a task budgeted at 200k are
//! each inside their budget and have burned six hundred thousand tokens between them in
//! twenty minutes, and nothing in a per-attempt ceiling can see it — every attempt it
//! could see was fine. The rate is the missing figure, and these run the real binary
//! because the claim is about three pieces agreeing: the attempts the store holds, the
//! rate `wecode show` reads off them, and the ceiling `company.toml` writes.

mod support;

use support::Org;

/// Files an attested attempt against a task, as somebody who worked it in their own
/// session would. `wecode cost` stamps the row at now, so two of them are two attempts
/// inside the same hour — which is the burst the breaker is about.
fn charge(org: &Org, task: &str, tokens: &str) {
    org.run(&["cost", task, "worked it in my own session", "--tokens", tokens])
        .assert_ok("cost");
}

#[test]
fn attempts_inside_one_hour_are_read_as_a_rate_and_not_only_as_costs() {
    let org = Org::new("spend-spike", "software-company");
    org.seed();

    // One attempt is a cost. Its figure is already on its own row, and restating it
    // underneath would be the same number twice.
    charge(&org, "cache-tests", "200000");
    org.run(&["show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("200000t")
        .assert_lacks("spike");

    // Two more, minutes apart, each of them inside the 50000-token budget the task was
    // given — and six hundred thousand tokens between the three.
    charge(&org, "cache-tests", "200000");
    charge(&org, "cache-tests", "200000");
    org.run(&["show", "cache-tests"])
        .assert_ok("show")
        .assert_contains("spike  600000t over 3 attempts in one hour");
}

#[test]
fn the_hourly_ceiling_is_written_where_the_mid_run_kill_is_and_is_independent_of_it() {
    // The two keys are separate on purpose: `enforce` kills a run in flight and
    // destroys work already paid for, while the rate refuses to *start* the next one.
    // An operator must be able to have the second without the first.
    let org = Org::new("spend-ceiling", "software-company");
    let conf = org.path("company.toml");
    let text = std::fs::read_to_string(&conf).unwrap();
    std::fs::write(
        &conf,
        format!("{text}\n[budgets]\nmax_tokens_per_hour = 500000\n"),
    )
    .unwrap();

    // The binary still loads the file — an unknown key here is refused at parse, so
    // this failing would mean the key does not exist.
    org.run(&["company", "show"]).assert_ok("company show");

    let company = wecode_org::company::Company::parse(&std::fs::read_to_string(&conf).unwrap())
        .expect("the company parses");
    assert_eq!(company.budgets.max_tokens_per_hour, Some(500_000));
    assert!(!company.budgets.enforce, "the breaker is not the kill switch");
}

#[test]
fn a_company_that_never_heard_of_the_rate_has_no_breaker_at_all() {
    // The compatibility story, through the shipped template rather than a literal:
    // absent is off, and off is not a ceiling of zero.
    let org = Org::new("spend-default", "software-company");
    let text = std::fs::read_to_string(org.path("company.toml")).unwrap();
    let company = wecode_org::company::Company::parse(&text).expect("the shipped company parses");
    assert_eq!(company.budgets.max_tokens_per_hour, None);
}
