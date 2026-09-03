//! What a starter's `engineer` may write, asserted from outside the crate.
//!
//! The specification is the mandated information item (ISO/IEC/IEEE 15289 §10.x names
//! it and no separate author), so the seat that ships the code has to be able to keep
//! it true. That grant has one edge worth pinning: it must not reach the two documents
//! the engineer is not the author of — the report, which is generated, and the tests.

use wecode_org::Company;
use wecode_org::template::{self, Template};

fn company_of(t: &Template) -> Company {
    let toml = t
        .files
        .iter()
        .find(|(p, _)| *p == "company.toml")
        .map(|(_, c)| *c)
        .unwrap_or_else(|| panic!("{} has no company.toml", t.name));
    Company::parse(toml).unwrap_or_else(|e| panic!("{} does not parse: {e}", t.name))
}

const SPEC: &str = "specs/014-a-slice/specification.md";
const REPORT: &str = "specs/014-a-slice/report_as_finished.md";

#[test]
fn every_default_engineer_maintains_the_specification_it_builds_against() {
    for t in template::all() {
        let c = company_of(t);
        let eng = c
            .roles
            .get("engineer")
            .unwrap_or_else(|| panic!("{} has no engineer role", t.name));
        assert!(
            eng.allows_write(SPEC),
            "{}: the engineer ships code it cannot document",
            t.name
        );
    }
}

#[test]
fn no_default_engineer_writes_the_report_generated_from_its_own_diff() {
    // The report's numbers come from `git diff --numstat`. A seat that could author it
    // could author its own account of the work, which is the thing that is inadmissible.
    for t in template::all() {
        let c = company_of(t);
        assert!(
            !c.roles["engineer"].allows_write(REPORT),
            "{}: the engineer may hand-write its own report",
            t.name
        );
    }
}

#[test]
fn the_contract_belongs_to_the_engineer_and_the_rspec_directory_to_the_tester() {
    // `spec/**` and `specs/**` are one letter apart in the same file and have different
    // owners. Both directions are asserted, because either being wrong reads as a typo
    // that works.
    let c = company_of(&template::SOFTWARE_COMPANY);
    let eng = &c.roles["engineer"];
    let test = &c.roles["tester"];

    assert!(!test.allows_write(SPEC), "the tester may write the contract");
    assert!(
        !eng.allows_write("spec/models/user_spec.rb"),
        "the engineer reaches into the tester's directory"
    );
    assert!(test.allows_write("spec/models/user_spec.rb"));
}

#[test]
fn the_specification_grant_does_not_widen_to_the_directory() {
    // Named per-document rather than as `specs/**`: the folder also carries generated
    // and hand-kept files, and a glob over it would take them with it.
    for t in template::all() {
        let c = company_of(t);
        let eng = &c.roles["engineer"];
        assert!(!eng.allows_write("specs/README.md"), "{}", t.name);
        assert!(
            !eng.allows_write("specs/_TEMPLATE-specification.md"),
            "{}: the template a spec is copied from is not a spec",
            t.name
        );
    }
}
