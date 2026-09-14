//! Shared strict parsing for the native administrator and laboratory commands.
use crate::error::{Error, Result};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Options {
    pub values: BTreeMap<String, String>,
    pub flags: BTreeSet<String>,
}
pub(crate) fn parse(
    args: impl Iterator<Item = String>,
    valued: &[&str],
    flags: &[&str],
) -> Result<Options> {
    let mut out = Options::default();
    let mut args = args;
    while let Some(arg) = args.next() {
        let (key, inline) = arg
            .split_once('=')
            .map(|(k, v)| (k, Some(v)))
            .unwrap_or((&arg, None));
        if valued.contains(&key) {
            let value = match inline {
                Some(v) => v.into(),
                None => args
                    .next()
                    .filter(|v| !v.starts_with("--"))
                    .ok_or_else(|| Error::invalid(format!("Missing value for {key}")))?,
            };
            if out.values.insert(key.into(), value).is_some() {
                return Err(Error::invalid(format!("Duplicate {key}")));
            }
        } else if flags.contains(&key) && inline.is_none() {
            out.flags.insert(key.into());
        } else {
            return Err(Error::invalid(format!("Unknown option: {arg}")));
        }
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn options(args: &[&str]) -> Result<Options> {
        parse(
            args.iter().map(|s| s.to_string()),
            &["--user", "--vault", "--data-dir"],
            &["--apply", "--server-stopped", "--help"],
        )
    }
    #[test]
    fn string_options_accept_both_cli_spellings_without_interpreting_values() {
        assert_eq!(
            options(&[
                "--user",
                "owner@example.test",
                "--data-dir",
                "/tmp/dir with spaces",
                "--vault",
                "a=b"
            ])
            .unwrap(),
            options(&[
                "--user=owner@example.test",
                "--data-dir=/tmp/dir with spaces",
                "--vault=a=b"
            ])
            .unwrap()
        );
    }
    #[test]
    fn reset_flags_remain_explicit_and_cannot_be_swallowed_as_missing_values() {
        assert!(options(&["--user", "--apply"]).is_err());
        assert!(options(&["--apply=false"]).is_err());
        assert!(options(&["--server-stopped=true"]).is_err());
        let preview = options(&["--user=owner", "--vault=id"]).unwrap();
        assert!(preview.flags.is_empty());
        let apply =
            options(&["--user=owner", "--vault=id", "--apply", "--server-stopped"]).unwrap();
        assert!(apply.flags.contains("--apply"));
        assert!(apply.flags.contains("--server-stopped"));
    }
    #[test]
    fn unknown_duplicate_and_missing_options_fail_before_execution() {
        for args in [
            vec!["--user"],
            vec!["--user=a", "--user=b"],
            vec!["--unknown"],
            vec!["bare-positional"],
        ] {
            assert!(options(&args).is_err());
        }
    }
}
