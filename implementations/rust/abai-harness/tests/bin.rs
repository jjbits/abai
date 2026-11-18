use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_abai-harness");

#[test]
fn version_flag_prints_the_version_line() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        "abai-harness 0.1.0 (stub 0.1.0)"
    );
}

#[test]
fn no_arguments_exits_with_code_2() {
    let out = Command::new(BIN).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}
