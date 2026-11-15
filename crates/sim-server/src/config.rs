//! Command-line flags, the auth token, and the hooks block for `~/.claude/settings.json`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use clap::{Args, Parser, Subcommand};
use rand::Rng;
use serde_json::{Map, Value, json};

/// Command-line interface.
#[derive(Debug, Parser)]
#[command(
    name = "simagent",
    version,
    about = "Live mission control for Claude Code"
)]
pub struct Cli {
    /// What to do; defaults to `serve`.
    #[command(subcommand)]
    pub command: Option<Command>,
    /// Options shared by all subcommands.
    #[command(flatten)]
    pub opts: Opts,
}

/// Subcommands.
#[derive(Debug, Clone, Default, Subcommand)]
pub enum Command {
    /// Run the server (default).
    #[default]
    Serve,
    /// Claude Code hooks helpers.
    Hooks {
        /// Which helper.
        #[command(subcommand)]
        action: HooksCommand,
    },
    /// Test bench: run the server against scripted, realistic sessions written in real
    /// time to a temp dir (no real Claude Code session needed).
    Demo(crate::demo::DemoArgs),
    /// Parse a transcript `.jsonl` and print its event timeline.
    Replay {
        /// Transcript file.
        file: PathBuf,
    },
}

/// `simagent hooks ...` helpers.
#[derive(Debug, Clone, Subcommand)]
pub enum HooksCommand {
    /// Print the JSON hooks block to merge into `~/.claude/settings.json`.
    Print,
    /// Add simagent's hooks to `~/.claude/settings.json`, keeping all existing hooks.
    /// Writes a `.bak` copy first. Running it twice does not duplicate entries.
    Install,
    /// Remove simagent's hooks from `~/.claude/settings.json`, leaving others untouched.
    Uninstall,
}

/// Options shared by all subcommands (`global = true` so they work after the subcommand).
#[derive(Debug, Clone, Args)]
pub struct Opts {
    /// TCP port to listen on. The host is always 127.0.0.1.
    #[arg(long, global = true, default_value_t = 7410)]
    pub port: u16,
    /// Claude Code projects directory (default `~/.claude/projects`).
    #[arg(long, global = true)]
    pub projects_dir: Option<PathBuf>,
    /// At startup, only load transcripts modified within this many minutes.
    #[arg(long, global = true, default_value_t = 120)]
    pub active_within_mins: u64,
    /// How long a permission request waits for the browser before falling back.
    #[arg(long, global = true, default_value_t = 120)]
    pub permission_timeout_secs: u64,
    /// Do not open the browser on start.
    #[arg(long, global = true)]
    pub no_open: bool,
}

impl Opts {
    /// The projects directory, resolving the `~/.claude/projects` default.
    #[must_use]
    pub fn projects_dir(&self) -> PathBuf {
        self.projects_dir
            .clone()
            .unwrap_or_else(default_projects_dir)
    }

    /// Permission wait as a [`Duration`].
    #[must_use]
    pub fn permission_timeout(&self) -> Duration {
        Duration::from_secs(self.permission_timeout_secs)
    }

    /// Startup window for transcripts as a [`Duration`].
    #[must_use]
    pub fn active_within(&self) -> Duration {
        Duration::from_secs(self.active_within_mins.saturating_mul(60))
    }
}

/// `~/.claude/projects`, where Claude Code writes transcripts.
#[must_use]
pub fn default_projects_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
}

/// Where the token is persisted: `~/.config/simagent/token`.
fn token_path() -> anyhow::Result<PathBuf> {
    let home = dirs::home_dir().context("could not determine home directory")?;
    Ok(home.join(".config").join("simagent").join("token"))
}

/// Loads the token from `~/.config/simagent/token`, creating it on first run.
///
/// A stable token means the hooks block in `settings.json` keeps working across restarts.
///
/// # Errors
/// When the home directory is unknown or the file cannot be read or written.
pub fn load_or_create_token() -> anyhow::Result<String> {
    load_or_create_token_at(&token_path()?)
}

/// [`load_or_create_token`] with an explicit path (used by tests).
///
/// # Errors
/// When the file cannot be read or written.
pub fn load_or_create_token_at(path: &Path) -> anyhow::Result<String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let trimmed = existing.trim();
        if trimmed.len() >= 16 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(trimmed.to_owned());
        }
        tracing::warn!(path = %path.display(), "token file malformed; regenerating");
    }
    let token = generate_token();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    std::fs::write(path, &token).with_context(|| format!("writing {}", path.display()))?;
    restrict_permissions(path);
    Ok(token)
}

/// 32 random hex characters (128 bits).
#[must_use]
pub fn generate_token() -> String {
    let bytes: [u8; 16] = rand::rng().random();
    crate::hex(&bytes)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(err) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!(%err, path = %path.display(), "could not chmod token file");
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// Hook events simagent registers, and whether each one takes a tool `matcher`.
const HOOK_EVENTS: [(&str, bool); 10] = [
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("PermissionRequest", true),
    ("Notification", false),
    ("Stop", false),
    ("SubagentStart", false),
    ("SubagentStop", false),
    ("PreCompact", false),
];

/// Builds the `{"hooks": {...}}` block pointing every hook at this server.
#[must_use]
pub fn hooks_json(port: u16, token: &str, permission_timeout_secs: u64) -> Value {
    let mut hooks = Map::new();
    for (event, has_matcher) in HOOK_EVENTS {
        // PermissionRequest blocks while the browser decides, so Claude Code must wait
        // longer than our own timeout; everything else is fire-and-forget.
        let timeout = if event == "PermissionRequest" {
            permission_timeout_secs.saturating_add(10)
        } else {
            5
        };
        let handler = json!({
            "type": "http",
            "url": format!("http://127.0.0.1:{port}/hooks/{event}"),
            "headers": { TOKEN_HEADER: token },
            "timeout": timeout,
        });
        let mut entry = Map::new();
        if has_matcher {
            entry.insert("matcher".into(), json!("*"));
        }
        entry.insert("hooks".into(), json!([handler]));
        hooks.insert(event.into(), json!([Value::Object(entry)]));
    }
    json!({ "hooks": Value::Object(hooks) })
}

/// `simagent hooks print`: writes the hooks block to stdout.
///
/// # Errors
/// When the token cannot be loaded or serialization fails.
#[allow(clippy::print_stdout)] // CLI output: the user pipes or copies this JSON.
pub fn print_hooks(opts: &Opts) -> anyhow::Result<()> {
    let token = load_or_create_token()?;
    let block = hooks_json(opts.port, &token, opts.permission_timeout_secs);
    println!("{}", serde_json::to_string_pretty(&block)?);
    Ok(())
}

/// Marker that identifies hook handlers written by simagent (their URL path).
const HOOK_URL_MARK: &str = "/hooks/";

/// Header carrying the token on hook requests; also how `hooks install` recognises its
/// own entries in `settings.json`.
const TOKEN_HEADER: &str = "X-Simagent-Token";

/// True when a handler object is one of ours: an http hook carrying our token header.
fn is_simagent_handler(handler: &Value) -> bool {
    handler.get("type").and_then(Value::as_str) == Some("http")
        && handler
            .get("headers")
            .is_some_and(|h| h.get(TOKEN_HEADER).is_some())
        && handler
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|u| u.starts_with("http://127.0.0.1:") && u.contains(HOOK_URL_MARK))
}

/// Removes every simagent handler from a settings object, dropping matcher groups and
/// event keys that become empty. Other hooks are left exactly as they were.
pub fn strip_simagent_hooks(settings: &mut Value) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    for groups in hooks.values_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        for group in groups.iter_mut() {
            if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                handlers.retain(|h| !is_simagent_handler(h));
            }
        }
        groups.retain(|g| {
            g.get("hooks")
                .and_then(Value::as_array)
                .is_none_or(|h| !h.is_empty())
        });
    }
    hooks.retain(|_, groups| groups.as_array().is_none_or(|g| !g.is_empty()));
}

/// Merges simagent's hook block into `settings`, replacing any older simagent entries.
///
/// # Errors
/// When `settings` or its `hooks` field is not a JSON object.
pub fn merge_simagent_hooks(settings: &mut Value, block: &Value) -> anyhow::Result<()> {
    strip_simagent_hooks(settings);
    let root = settings
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("settings.json is not a JSON object"))?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("settings.json `hooks` is not an object"))?;
    if let Some(ours) = block.get("hooks").and_then(Value::as_object) {
        for (event, groups) in ours {
            let list = hooks.entry(event.clone()).or_insert_with(|| json!([]));
            if let (Some(list), Some(groups)) = (list.as_array_mut(), groups.as_array()) {
                list.extend(groups.iter().cloned());
            }
        }
    }
    Ok(())
}

/// Path of the user's Claude Code settings file.
fn settings_path() -> anyhow::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home directory"))?;
    Ok(home.join(".claude").join("settings.json"))
}

/// `simagent hooks install` / `uninstall`: edits `~/.claude/settings.json` in place.
///
/// # Errors
/// When the settings file cannot be read, parsed, backed up or written.
#[allow(clippy::print_stdout)] // CLI output: tells the user what changed.
pub fn edit_settings(opts: &Opts, install: bool) -> anyhow::Result<()> {
    use anyhow::Context as _;
    let path = settings_path()?;
    let mut settings: Value = if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?
    } else {
        json!({})
    };
    if path.exists() {
        let backup = path.with_extension("json.simagent.bak");
        std::fs::copy(&path, &backup)
            .with_context(|| format!("backing up to {}", backup.display()))?;
        println!("backup written to {}", backup.display());
    }
    if install {
        let token = load_or_create_token()?;
        merge_simagent_hooks(
            &mut settings,
            &hooks_json(opts.port, &token, opts.permission_timeout_secs),
        )?;
    } else {
        strip_simagent_hooks(&mut settings);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&settings)? + "\n")
        .with_context(|| format!("writing {}", path.display()))?;
    println!(
        "{} simagent hooks in {}. New Claude Code sessions pick this up.",
        if install { "installed" } else { "removed" },
        path.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_keeps_foreign_hooks_and_is_idempotent() {
        let mut settings = json!({
            "model": "x",
            "hooks": { "PreToolUse": [ { "hooks": [ { "type": "command", "command": "node other.js" } ] } ] }
        });
        let block = hooks_json(7410, "tok", 120);
        merge_simagent_hooks(&mut settings, &block).unwrap();
        merge_simagent_hooks(&mut settings, &block).unwrap();
        let pre = settings["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2, "foreign group kept, ours added once");
        assert_eq!(pre[0]["hooks"][0]["command"], "node other.js");
        assert_eq!(settings["model"], "x");

        strip_simagent_hooks(&mut settings);
        assert_eq!(settings["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        assert!(settings["hooks"].get("PermissionRequest").is_none());
    }

    #[test]
    fn token_is_32_hex_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("token");
        let first = load_or_create_token_at(&path).unwrap();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(load_or_create_token_at(&path).unwrap(), first);
    }

    #[test]
    fn hooks_block_has_matchers_only_on_tool_events() {
        let v = hooks_json(7410, "abc", 120);
        let pre = &v["hooks"]["PreToolUse"][0];
        assert_eq!(pre["matcher"], "*");
        assert_eq!(
            pre["hooks"][0]["url"],
            "http://127.0.0.1:7410/hooks/PreToolUse"
        );
        assert_eq!(pre["hooks"][0]["headers"]["X-Simagent-Token"], "abc");
        assert_eq!(pre["hooks"][0]["timeout"], 5);
        assert!(v["hooks"]["Stop"][0].get("matcher").is_none());
        assert_eq!(
            v["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"],
            130
        );
    }

    #[test]
    fn cli_defaults_to_serve() {
        let cli = Cli::try_parse_from(["simagent", "--no-open"]).unwrap();
        assert!(cli.command.is_none());
        assert_eq!(cli.opts.port, 7410);
        assert!(cli.opts.no_open);
    }
}
