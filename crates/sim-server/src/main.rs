//! `simagent` binary: parses flags, sets up logging, and dispatches the subcommand.

use clap::Parser;
use tracing_subscriber::EnvFilter;

use sim_server::config::{Cli, Command, HooksCommand};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logs go to stderr so `hooks print` / `replay` output on stdout stays clean.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cli = Cli::parse();
    match cli.command.unwrap_or_default() {
        Command::Serve => sim_server::http::serve(&cli.opts).await,
        Command::Hooks {
            action: HooksCommand::Print,
        } => sim_server::config::print_hooks(&cli.opts),
        Command::Hooks {
            action: HooksCommand::Install,
        } => sim_server::config::edit_settings(&cli.opts, true),
        Command::Hooks {
            action: HooksCommand::Uninstall,
        } => sim_server::config::edit_settings(&cli.opts, false),
        Command::Demo(args) => sim_server::demo::run(&cli.opts, &args).await,
        Command::Replay { file } => sim_server::replay::run(&file),
    }
}
