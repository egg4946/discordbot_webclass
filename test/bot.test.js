import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'discord.js';

// Loads the real bot with a fake environment in a scratch directory (no .env, no real data,
// no network). discord.js turns a rejected listener into an 'error' event, which crashes the
// process unless handled, so every listener must settle without rejecting.
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalLogin = Client.prototype.login;
let workDir;
let client;
let ownerLookups = 0;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'webclass-bot-test-'));
  await mkdir(join(workDir, 'data'));
  const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  await writeFile(
    join(workDir, 'data/state.json'),
    JSON.stringify({
      assignments: [
        { stableKey: 'k1', courseName: '科学技術論B', title: '第1回課題', deadlineText: 'later', deadlineAt: deadline, status: '未提出' },
      ],
      notified: {},
      updatedAt: new Date().toISOString(),
    }),
  );
  process.chdir(workDir);

  Object.assign(process.env, {
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_CHANNEL_ID: 'channel',
    DISCORD_GUILD_ID: 'guild',
    WEBCLASS_LOGIN_URL: 'https://webclass.nanzan-u.ac.jp/webclass/login.php',
    WEBCLASS_USER_ID: 'user',
    WEBCLASS_PASSWORD: 'password',
  });
  delete process.env.DISCORD_OWNER_USER_ID;

  // The owner lookup fails while the bot starts and works afterwards.
  globalThis.fetch = async () => {
    ownerLookups += 1;
    return ownerLookups === 1
      ? new Response('unavailable', { status: 503 })
      : Response.json({ owner: { id: 'owner' } });
  };
  Client.prototype.login = async function login() {
    client = this;
    return 'test-token';
  };

  await import('../src/bot.js');
  while (!client) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  client.user = { tag: 'bot#0000' };
  client.guilds.fetch = async () => {
    throw new Error('Missing Access');
  };
});

after(async () => {
  await client?.destroy();
  Client.prototype.login = originalLogin;
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

function fakeInteraction({ commandName, userId = 'owner', failDefer = false, failEdit = false }) {
  const calls = [];
  return {
    calls,
    commandName,
    user: { id: userId },
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    options: { getBoolean: () => null, getString: () => null, getFocused: () => '' },
    async deferReply(options) {
      if (failDefer) throw new Error('Unknown interaction');
      this.deferred = true;
      calls.push(['deferReply', options]);
    },
    async editReply(options) {
      if (failEdit) throw new Error('Unknown Webhook');
      calls.push(['editReply', options]);
    },
    async followUp(options) {
      calls.push(['followUp', options]);
    },
  };
}

function emitInteraction(interaction) {
  return Promise.all(client.listeners('interactionCreate').map((listener) => listener(interaction)));
}

test('a failed command registration at startup does not crash the bot', async () => {
  await Promise.all(client.listeners('clientReady').map((listener) => listener(client)));
});

test('the owner is looked up again when it could not be resolved at startup', async () => {
  const interaction = fakeInteraction({ commandName: 'webclass-unsubmitted' });
  await emitInteraction(interaction);

  const [, reply] = interaction.calls.find(([name]) => name === 'editReply');
  assert.equal(reply.embeds[0].title, '未提出のWebClass課題 (1件)');
});

test('owner-only commands are refused to other users', async () => {
  const interaction = fakeInteraction({ commandName: 'webclass-next', userId: 'someone-else' });
  await emitInteraction(interaction);

  assert.deepEqual(interaction.calls.at(-1), [
    'editReply',
    'このコマンド（またはオプション）はBot所有者だけが使用できます。',
  ]);
});

test('an expired interaction does not crash the bot', async () => {
  const interaction = fakeInteraction({ commandName: 'webclass-all', failDefer: true });
  await emitInteraction(interaction);
  assert.deepEqual(interaction.calls, []);
});

test('a failed reply does not crash the bot', async () => {
  const interaction = fakeInteraction({ commandName: 'webclass-all', failEdit: true });
  await emitInteraction(interaction);
  assert.equal(interaction.calls[0][0], 'deferReply');
});
