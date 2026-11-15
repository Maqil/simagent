import { useStore } from '../store';
import { Mascot } from './Mascot';

export function EmptyState() {
  const connection = useStore((s) => s.connection);
  return (
    <div className="empty">
      <Mascot blinking={false} scale={8} />
      <h1>No sessions yet</h1>
      {connection === 'live' || connection === 'demo' ? (
        <p>simagent is watching. Start Claude Code in any project and it shows up here live.</p>
      ) : (
        <p>Waiting for the simagent server… make sure it is running (<code>just run</code>).</p>
      )}
      <ol>
        <li>
          Run <code>claude</code> in a project directory.
        </li>
        <li>
          For live approvals, install the hooks: <code>simagent hooks print</code> and add the output to your
          Claude Code settings.
        </li>
        <li>
          Just exploring? Open <a href="?demo=1">the demo</a>.
        </li>
      </ol>
    </div>
  );
}
