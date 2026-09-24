import { loadTaskConfig } from './config.js';
import { formatDeadline, isMaterial, fetchTask, listContents } from './task-fetch.js';
import { generateAnswers, isReportQuestion, PROVIDERS, renderReport, selectProvider } from './task-answer.js';
import { approveTask, reviewTask, submitTask } from './task-submit.js';
import { retryTask } from './task-retry.js';
import { readTask, taskDir, taskId } from './task-store.js';

const USAGE = `WebClass課題ワークフロー

  npm run task -- list [--json]                      課題の一覧（資料は除く）
  npm run task -- fetch "<授業名 課題名>" [--allow-attempt] [--material <資料名>] [--no-materials] [--force]
  npm run task -- answer <task-id> [claude|codex|both] [--prefer claude|codex]
  npm run task -- select <task-id> <claude|codex> [設問番号...]
  npm run task -- render <task-id> [設問番号...]            report-qN.md からPDFを作り直す
  npm run task -- review <task-id>
  npm run task -- dry-run <task-id>                 入力して画面を保存（採点は押さない）
  npm run task -- approve <task-id> <承認用ハッシュ>
  npm run task -- submit <task-id>                  承認済みの解答を提出（採点ボタンを押す）
  npm run task -- retry <task-id> [claude|codex|both] [設問番号...]  提出後に間違えた設問だけ解き直す
  npm run task -- status <task-id>`;

const [command, ...rawArgs] = process.argv.slice(2);
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--')));
const positional = [];
const optionValues = {};
for (let index = 0; index < rawArgs.length; index++) {
  const arg = rawArgs[index];
  if (['--material', '--prefer'].includes(arg)) {
    (optionValues[arg] ??= []).push(rawArgs[++index]);
  } else if (!arg.startsWith('--')) {
    positional.push(arg);
  }
}

async function main() {
  switch (command) {
    case 'list': {
      const contents = await listContents(loadTaskConfig());
      // --json is what the local UI (npm run task:ui) reads; it prints nothing else.
      if (flags.has('--json')) {
        console.log(JSON.stringify(contents.map((item) => ({ ...item, taskId: taskId(item.contentsId), material: isMaterial(item) }))));
        break;
      }
      for (const item of contents.filter((content) => !isMaterial(content))) {
        console.log([taskId(item.contentsId), item.category, formatDeadline(item.deadlineAt), `${item.courseName} / ${item.title}`].join('\t'));
      }
      break;
    }
    case 'fetch': {
      const task = await fetchTask(loadTaskConfig(), positional.join(' '), {
        allowAttempt: flags.has('--allow-attempt'),
        materials: !flags.has('--no-materials'),
        materialQueries: optionValues['--material'] ?? [],
        force: flags.has('--force'),
      });
      console.log(`取得しました: ${task.item.courseName} / ${task.item.title}`);
      console.log(`task-id: ${task.id}`);
      console.log(`設問: ${task.questions.length}問 (${task.questions.map((question) => question.kind).join(', ')})`);
      if (task.layout === 'paged') {
        console.log(`形式: 1ページずつ表示されるテスト（全${Math.max(...task.questions.map((question) => question.page))}ページ）。各ページを1回ずつ開きましたが、何も入力・採点していません。`);
      }
      if (task.unsupported.length) console.log(`⚠ 自動入力に未対応の設問: ${task.unsupported.join(', ')}`);
      const reportQuestions = task.questions.filter(isReportQuestion).map((question) => question.number);
      if (reportQuestions.length) {
        console.log(`📎 レポート（ファイル提出）の設問: ${reportQuestions.join(', ')}（answer でAIが本文を書き、PDFにして提出します）`);
      }
      const manualFiles = task.questions
        .filter((question) => question.kind === 'file' && !isReportQuestion(question)).map((question) => question.number);
      if (manualFiles.length) {
        console.log(`📎 自分でファイルを用意する設問: ${manualFiles.join(', ')}（ファイルを ${taskDir(task.id)} に置き、answer.json に相対パスを書いてください）`);
      }
      console.log(`資料: ${task.materials.map((material) => `${material.title}${material.readable ? '' : '（読み取り不可）'}`).join(', ') || 'なし'}`);
      console.log(`フォルダ: ${taskDir(task.id)}`);
      break;
    }
    case 'answer': {
      const [id, which = 'both'] = positional;
      const providers = which === 'both' ? PROVIDERS : [which];
      const { results, draft } = await generateAnswers(id, providers, { prefer: optionValues['--prefer']?.[0] });
      for (const result of results) {
        console.log(result.error
          ? `✗ ${result.provider}: ${result.error}`
          : `✓ ${result.provider} (${result.model} / effort ${result.effort}): 解答案を作成しました`);
      }
      for (const answer of draft.answers.filter((item) => item.values.some((value) => /^report-q\d+\.pdf$/.test(value)))) {
        console.log(`📄 設問${answer.question}: レポートを report-q${answer.question}.md と report-q${answer.question}.pdf に作成しました（本文は review で確認してください）`);
      }
      const conflicts = draft.answers.filter((answer) => answer.conflict).map((answer) => answer.question);
      if (results.filter((result) => !result.error).length > 1) {
        console.log(conflicts.length ? `⚠ AIの案が一致しなかった設問（レポートは本文を読み比べてください）: ${conflicts.join(', ')}` : '両方のAIの解答が一致しました。');
      }
      console.log(`次: npm run task -- review ${id}`);
      break;
    }
    case 'render': {
      const [id, ...questions] = positional;
      for (const { question, path } of await renderReport(id, questions)) {
        console.log(`設問${question}: ${path} を作成しました。`);
      }
      console.log(`承認は取り消されました。次: npm run task -- review ${id}`);
      break;
    }
    case 'select': {
      const [id, provider, ...questions] = positional;
      await selectProvider(id, provider, questions);
      console.log(`${provider} の解答を answer.json に反映しました。review で確認してください。`);
      break;
    }
    case 'review': {
      const { markdown, digest, path } = await reviewTask(positional[0]);
      console.log(markdown);
      console.log(`\n保存先: ${path}`);
      console.log(`承認する場合: npm run task -- approve ${positional[0]} ${digest.slice(0, 16)}`);
      break;
    }
    case 'dry-run': {
      const result = await submitTask(loadTaskConfig(), positional[0], { dryRun: true, allowAttempt: flags.has('--allow-attempt') });
      console.log(`入力のみ行いました（提出していません）。画面:\n${result.screenshot}`);
      break;
    }
    case 'approve': {
      const [id, hash] = positional;
      await approveTask(id, hash);
      console.log(`承認しました。提出する場合: npm run task -- submit ${id}`);
      break;
    }
    case 'submit': {
      const result = await submitTask(loadTaskConfig(), positional[0], { allowAttempt: flags.has('--allow-attempt') });
      console.log(result.verified
        ? `提出しました。結果: ${result.receipt}`
        : `採点ボタンは押しましたが、結果画面を確認できませんでした。再実行せず ${result.receipt} と ${result.screenshot} を確認してください。`);
      break;
    }
    case 'retry': {
      const [id, ...rest] = positional;
      const which = ['both', ...PROVIDERS].includes(rest[0]) ? rest.shift() : 'both';
      const { attempt, targets, previous, results, repeated, resumed } = await retryTask(id, {
        providers: which === 'both' ? PROVIDERS : [which],
        questions: rest,
        prefer: optionValues['--prefer']?.[0],
      });
      console.log(resumed
        ? `${attempt}回目の提出に向けた解き直しを、もう一度AIに解かせました。`
        : `前回の提出記録を attempts/${attempt - 1}/ に移し、${attempt}回目の提出の解答案を作りました。`);
      for (const item of previous) {
        const grade = item.grade ? `${item.grade.mark} ${item.grade.score}/${item.grade.max}点` : '指定';
        console.log(`設問${item.question}（前回 ${grade}）: ${item.describe.replace(/\n/g, ' / ')}`);
      }
      for (const result of results) {
        console.log(result.error
          ? `✗ ${result.provider}: ${result.error}`
          : `✓ ${result.provider} (${result.model} / effort ${result.effort}): 設問${targets.join(', ')}を解き直しました`);
      }
      if (repeated.length) console.log(`⚠ 前回不正解と同じ解答になった設問: ${repeated.join(', ')}（review で確認してください）`);
      console.log(`正解だった設問は前回の解答のままです。次: npm run task -- review ${id}`);
      break;
    }
    case 'status': {
      const task = await readTask(positional[0]);
      console.log(JSON.stringify({ id: task.id, status: task.status, course: task.item?.courseName, title: task.item?.title,
        deadline: formatDeadline(task.item?.deadlineAt), error: task.error, approval: task.approval,
        directory: taskDir(task.id) }, null, 2));
      break;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
