import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { fetchAssignments } from './webclass.js';

async function main() {
  const config = loadConfig();
  const assignments = await fetchAssignments(config, {
    onPage: ({ title, assignmentCount }) => {
      console.log(`[${assignmentCount}] ${title}`);
    },
    saveDebugHtml: async (html) => {
      await mkdir('debug', { recursive: true });
      await writeFile('debug/webclass.html', html, 'utf8');
    },
  });

  console.log(JSON.stringify(assignments, null, 2));
  console.log(`Saved debug HTML to debug/webclass.html`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
