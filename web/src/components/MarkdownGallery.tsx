// `/?gallery=md`: a sample agent reply rendered with the Markdown component, for checking
// the styling without a live session.
import { Markdown } from './Markdown';

const SAMPLE = `## Pushing to GitHub

No. The squash itself doesn't need **GitHub** at all. Steps 1 to 4 only change your *local* repo.

**You haven't created the GitHub repo yet** (the usual case):
1. Squash with steps 1 to 4 from before.
2. On github.com, click **New repository** and name it \`simagent\`.
3. Connect it and push:
   \`\`\`sh
   git remote add origin git@github.com:<your-username>/simagent.git
   git push -u origin main   # first push
   \`\`\`

**You created the repo but haven't pushed yet:**
- If you left it empty, do the same \`remote add\` and \`push\` as above.
- If you ticked README, overwrite it:
  - \`git push --force -u origin main\`

> Force-pushing replaces the remote history. Only do it on a fresh repo.

| Step | Needs GitHub | Command |
|------|:---:|---|
| Squash | no | \`git reset --soft\` |
| Push | yes | \`git push\` |

- [x] fmt and clippy
- [ ] push

\`\`\`rust
fn main() {
    let n: u32 = 42; // answer
    println!("{}", Some(n).unwrap_or(0));
}
\`\`\`

See https://docs.github.com for more.`;

export function MarkdownGallery() {
  return (
    <div style={{ padding: 24, background: '#050510', minHeight: '100vh' }}>
      <div className="bubble bubble--reply" style={{ maxWidth: 760 }}>
        <div className="bubble__body">
          <Markdown text={SAMPLE} />
        </div>
      </div>
    </div>
  );
}
