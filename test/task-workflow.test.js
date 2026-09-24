import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { extractAttachmentText } from '../src/task-extract.js';
import { decodeChapterList, extractCourseContents, roundNumbers, selectContent } from '../src/task-fetch.js';
import { collectReports, generateAnswers, isReportQuestion, mergeAnswers, parseSolverOutput, renderReport, renderReports, selectProvider } from '../src/task-answer.js';
import { markdownToHtml } from '../src/task-report.js';
import { describeValues, parseQuestionForm, parseQuestionText, questionFingerprint, renderQuestions, validateAnswers } from '../src/task-questions.js';
import { approveTask, reviewTask, submitTask, verifyUploaded } from '../src/task-submit.js';
import { answerDigest, readJson, readTask, readText, saveJson, saveTask, saveText, taskDir, taskPath } from '../src/task-store.js';
import { parseGradeResults, retryTask } from '../src/task-retry.js';

// Mirrors the markup of WebClass dqstn_answer_all.php.
const FORM = `
<form name="answer_form" method="POST">
  <input type="hidden" name="sendCmd">
  <dl class="question" id="id_question_1"><dt>設問 1</dt><dd><span><style>span{}</style>次の<span class="box">(1)</span>を答えよ。<ol><li>一つ目</li></ol></span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_1">
    <input type="hidden" name="QuestionAnswer[1][style]" value="wordinput">
    <table class="wordinput"><tr><td class="prefix">(1)</td><td class="inputField"><input type="text" name="QuestionAnswer[1][value][]" value="前回" maxlength="10"></td></tr></table>
  </fieldset></td></tr><tr><td class="point">( 2 )</td></tr></table>
  <dl class="question" id="id_question_2"><dt>設問 2</dt><dd><span>不適切なものをすべて選べ。</span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_2">
    <input type="hidden" name="QuestionAnswer[2][style]" value="checkbox">
    <table class="seloptions">
      <tr><th class="prefix"><label for="2_1">1.</label></th><td><input id="2_1" type="checkbox" name="QuestionAnswer[2][value][]" value="1"></td><td class="option-labels"><label for="2_1">甲</label></td></tr>
      <tr><th class="prefix"><label for="2_2">2.</label></th><td><input id="2_2" type="checkbox" name="QuestionAnswer[2][value][]" value="2"></td><td class="option-labels"><label for="2_2">乙</label></td></tr>
    </table>
  </fieldset></td></tr></table>
  <dl class="question" id="id_question_3"><dt>設問 3</dt><dd><span>1つ選べ。</span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_3">
    <input type="hidden" name="QuestionAnswer[3][style]" value="radio">
    <table class="seloptions">
      <tr><th class="prefix"><label for="3_1">1.</label></th><td><input id="3_1" type="radio" name="QuestionAnswer[3][value]" value="1"></td><td class="option-label"><label for="3_1">丙</label></td></tr>
      <tr><th class="prefix"><label for="3_2">2.</label></th><td><input id="3_2" type="radio" name="QuestionAnswer[3][value]" value="2"></td><td class="option-label"><label for="3_2">丁</label></td></tr>
    </table>
  </fieldset></td></tr></table>
  <dl class="question" id="id_question_4"><dt>設問 4</dt><dd><span>対応を選べ。</span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_4">
    <input type="hidden" name="QuestionAnswer[4][style]" value="matching">
    <table class="selcomplex"><tr><th>(1)</th><td>上流工程の問題</td><td>&gt;</td><td>
      <select name="QuestionAnswer[4][value][]"><option value="未解答">未解答</option><option value="1">説明A</option><option value="2">説明B</option></select>
    </td></tr></table>
  </fieldset></td></tr></table>
  <dl class="question" id="id_question_5"><dt>設問 5</dt><dd><span>レポートを提出せよ。</span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_5">
    <input type="hidden" name="QuestionAnswer[5][style]" value="report">
    <span id="file5"><input type="file" name="report5" accept=".pdf,.docx"></span>
    <input type="button" value="提出" onclick="sendReport('5', false)">
  </fieldset></td></tr></table>
  <dl class="question" id="id_question_6"><dt>設問 6</dt><dd><span>考察を書け。</span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_6">
    <input type="hidden" name="QuestionAnswer[6][style]" value="essay">
    <textarea name="QuestionAnswer[6][value]" data-min-length="5" data-max-length="20">下書き</textarea>
  </fieldset></td></tr></table>
  <dl class="question" id="id_question_7"><dt>設問 7</dt><dd><span>未知の形式。</span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_7">
    <input type="hidden" name="QuestionAnswer[7][style]" value="sequence">
  </fieldset></td></tr></table>
</form>`;

test('question parser classifies questions by their inputs', () => {
  const questions = parseQuestionForm(FORM);
  assert.deepEqual(questions.map((question) => [question.number, question.kind, question.supported]),
    [[1, 'text', true], [2, 'checkbox', true], [3, 'radio', true], [4, 'select', true],
      [5, 'file', true], [6, 'textarea', true], [7, 'unknown', false]]);
  assert.deepEqual(questions[4].parts, [{ label: '(1)', accept: '.pdf,.docx' }]);
  assert.deepEqual(questions[5].parts, [{ label: '(1)', minLength: 5, maxLength: 20, multiline: true }]);
  assert.deepEqual(questions[5].currentValues, ['下書き']);
  assert.equal(questions[0].text, '次の(1)を答えよ。\n- 一つ目');
  assert.equal(questions[0].points, '2');
  assert.deepEqual(questions[0].parts, [{ label: '(1)', maxLength: 10, multiline: false }]);
  assert.deepEqual(questions[0].currentValues, ['前回']);
  assert.deepEqual(questions[1].options, [{ value: '1', label: '甲' }, { value: '2', label: '乙' }]);
  assert.deepEqual(questions[2].options.map((option) => option.label), ['丙', '丁']);
  assert.deepEqual(questions[3].parts, [{ label: '(1) 上流工程の問題', options: [{ value: '1', label: '説明A' }, { value: '2', label: '説明B' }] }]);
});

test('fingerprint ignores previously entered values but not question changes', () => {
  const questions = parseQuestionForm(FORM);
  const cleared = parseQuestionForm(FORM.replace('value="前回"', 'value=""'));
  assert.equal(questionFingerprint(questions), questionFingerprint(cleared));
  assert.notEqual(questionFingerprint(questions), questionFingerprint(parseQuestionForm(FORM.replace('説明B', '説明C'))));
});

// Mirrors one page of a paged WebClass test: dqstn_answer.php has the inputs without the
// question text, which is in dqstn_question.php.
const PAGED_ANSWER = `
<form name="answer_form" method="POST"><input type="hidden" name="page" value="1"><input type="hidden" name="sendCmd">
  <table class="qstnoptions"><tbody><tr><td><fieldset id="QF_1"><input type="hidden" name="QuestionAnswer[1][style]" value="radio">
    <table class="seloptions"><tbody>
      <tr><th class="prefix"><label for="1_1">1.</label></th><td><input id="1_1" type="radio" name="QuestionAnswer[1][value]" value="1"></td><td class="option-label"><label for="1_1">〇</label></td></tr>
      <tr><th class="prefix"><label for="1_2">2.</label></th><td><input id="1_2" type="radio" name="QuestionAnswer[1][value]" value="2"></td><td class="option-label"><label for="1_2">×</label></td></tr>
    </tbody></table>
  </fieldset></td></tr></tbody></table>
  <table id="QstnOperation"><tr><td><input id="QstnNextBtn" type="button" value="次のページ"></td></tr><tr><td><button id="GradeBtn" type="button">終了</button></td></tr></table>
</form>`;
const PAGED_QUESTION = '<table><tr><td valign="bottom"><div class="question">導体は電気を通さない物質である。</div></td></tr></table>';

test('paged tests take the question text from the question frame', () => {
  const text = parseQuestionText(PAGED_QUESTION);
  assert.equal(text, '導体は電気を通さない物質である。');
  const [question] = parseQuestionForm(PAGED_ANSWER, { fallbackText: text });
  assert.equal(question.kind, 'radio');
  assert.equal(question.text, text);
  assert.deepEqual(question.options, [{ value: '1', label: '〇' }, { value: '2', label: '×' }]);

  // The page and form field numbers are part of the fingerprint only when present.
  const single = parseQuestionForm(FORM);
  assert.equal(questionFingerprint(single), questionFingerprint(single.map((item) => ({ ...item, page: undefined }))));
  assert.notEqual(questionFingerprint([{ ...question, page: 1, field: 1 }]), questionFingerprint([{ ...question, page: 2, field: 1 }]));
  assert.match(renderQuestions([{ ...question, kind: 'file', supported: false }]), /未対応/);
});

test('answer validation enforces counts and option values per style', () => {
  const questions = parseQuestionForm(FORM).slice(0, 4);
  const valid = [
    { question: 1, values: ['答え'] },
    { question: 2, values: [] },
    { question: 3, values: ['2'] },
    { question: 4, values: ['1'] },
  ];
  assert.equal(validateAnswers(questions, valid).length, 4);
  assert.throws(() => validateAnswers(questions, [...valid.slice(0, 3), { question: 4, values: ['未解答'] }]), /選択肢にない/);
  assert.throws(() => validateAnswers(questions, [{ ...valid[0], values: ['12345678901'] }, ...valid.slice(1)]), /文字数/);
  assert.throws(() => validateAnswers(questions, [valid[0], { question: 2, values: ['3'] }, ...valid.slice(2)]), /選択肢は/);
  assert.throws(() => validateAnswers(questions, [valid[0], valid[1], { question: 3, values: ['1', '2'] }, valid[3]]), /1つ/);
  assert.throws(() => validateAnswers(questions, valid.slice(1)), /設問1: 解答がありません/);
  const [file, essay, unknown] = parseQuestionForm(FORM).slice(4);
  assert.equal(validateAnswers([file, essay], [{ question: 5, values: ['report.pdf'] }, { question: 6, values: ['五文字以上'] }]).length, 2);
  assert.throws(() => validateAnswers([file], [{ question: 5, values: ['C:\\Users\\x.pdf'] }]), /相対パス/);
  assert.throws(() => validateAnswers([file], [{ question: 5, values: ['../secret.pdf'] }]), /相対パス/);
  assert.throws(() => validateAnswers([essay], [{ question: 6, values: ['短い'] }]), /下限/);
  assert.throws(() => validateAnswers([unknown], [{ question: 7, values: ['x'] }]), /未対応/);
  assert.equal(describeValues(questions[3], ['2']), '(1) 上流工程の問題 2. 説明B');
});

test('merging marks disagreements and ignores checkbox order and full-width text', () => {
  const questions = parseQuestionForm(FORM).slice(0, 4);
  const claude = { provider: 'claude', notes: '', answers: [
    { question: 1, values: ['QCD'] }, { question: 2, values: ['2', '1'] }, { question: 3, values: ['1'] }, { question: 4, values: ['1'] }] };
  const codex = { provider: 'codex', notes: 'memo', answers: [
    { question: 1, values: ['ＱＣＤ'] }, { question: 2, values: ['1', '2'] }, { question: 3, values: ['2'] }, { question: 4, values: ['1'] }] };
  const merged = mergeAnswers(questions, [codex, claude], 'claude');
  assert.deepEqual(merged.answers.map((answer) => [answer.source, answer.conflict]),
    [['agreed', false], ['agreed', false], ['claude', true], ['agreed', false]]);
  assert.deepEqual(merged.answers[2].values, ['1']);
  assert.equal(mergeAnswers(questions, [codex, claude], 'codex').answers[2].values[0], '2');

  // File questions are never answered by an AI: a path the user wrote is kept and flagged.
  const withFile = parseQuestionForm(FORM).slice(0, 5);
  const kept = mergeAnswers(withFile, [claude], 'claude', [{ question: 5, values: ['report.pdf'] }]);
  assert.deepEqual(kept.answers[4], { question: 5, values: ['report.pdf'], source: 'user', conflict: true });
});

test('solver output parser accepts fenced JSON', () => {
  assert.deepEqual(parseSolverOutput('```json\n{"answers":[{"question":1,"values":["a"]}],"notes":""}\n```').answers,
    [{ question: 1, values: ['a'] }]);
  assert.throws(() => parseSolverOutput('no json'), /JSON/);
});

test('approval binds the exact answer and submission refuses edited answers before opening WebClass', async () => {
  const id = 'abcdef0123456789';
  const questions = parseQuestionForm(FORM).slice(0, 3);
  await saveTask(id, { id, status: 'answered', questions, fingerprint: questionFingerprint(questions),
    item: { courseName: '授業', title: '課題', deadlineAt: null } });
  const answers = [{ question: 1, values: ['a'] }, { question: 2, values: ['1'] }, { question: 3, values: ['2'] }];
  await saveJson(id, 'answer.json', { providers: ['codex'], answers });
  try {
    const { digest, markdown } = await reviewTask(id);
    assert.match(markdown, /2\. 丁/);
    await assert.rejects(approveTask(id, 'wrong-hash-000'), /一致しません/);
    await approveTask(id, digest.slice(0, 16));
    await saveJson(id, 'answer.json', { providers: ['codex'], answers: [{ ...answers[0], values: ['b'] }, ...answers.slice(1)] });
    await assert.rejects(submitTask({}, id), /承認されていません/);
  } finally {
    await rm(taskDir(id), { recursive: true, force: true });
  }
});

test('report questions are drafted by the AI and rendered to a PDF', async () => {
  const id = 'abcdef0123456780';
  const [question] = parseQuestionForm(FORM).slice(4, 5);
  assert.equal(isReportQuestion(question), true);
  assert.deepEqual(collectReports([question], [
    { question: 5, markdown: '# 解答\n\nC が正しい。', confidence: 'high', evidence: '資料p.3' },
    { question: 6, markdown: '別の設問' },
    { question: 5, markdown: '   ' },
  ]), [{ question: 5, markdown: '# 解答\n\nC が正しい。', confidence: 'high', evidence: '資料p.3' }]);

  await saveTask(id, { id, status: 'answered', questions: [question], fingerprint: 'x',
    item: { courseName: '通信理論', title: '第１回課題', deadlineAt: null } });
  await saveText(id, 'report-q5.md', '# 問題1.1\n\n答え: C。10本中3本なので P = 3/10 で等しい。');
  await saveJson(id, 'answer.json', { providers: [], answers: [{ question: 5, values: [], source: 'none', conflict: true }] });
  try {
    const [rendered] = await renderReport(id);
    assert.equal(rendered.path, taskPath(id, 'report-q5.pdf'));
    assert.equal((await readFile(rendered.path)).subarray(0, 4).toString(), '%PDF');
    assert.deepEqual((await readJson(id, 'answer.json')).answers[0].values, ['report-q5.pdf']);
    // The rendered report is the answer, so review shows its text and approval covers its bytes.
    const { markdown, digest } = await reviewTask(id);
    assert.match(markdown, /答え: C。/);
    await saveText(id, 'report-q5.md', '# 問題1.1\n\n答え: A。');
    await renderReport(id);
    assert.notEqual((await reviewTask(id)).digest, digest);
  } finally {
    await rm(taskDir(id), { recursive: true, force: true });
  }
});

test('the approval hash covers the uploaded file, not only its path', () => {
  const answers = [{ question: 5, values: ['report-q5.pdf'] }];
  assert.notEqual(answerDigest(answers, { '5:report-q5.pdf': 'aa' }), answerDigest(answers, { '5:report-q5.pdf': 'bb' }));
  assert.equal(answerDigest(answers, { '5:report-q5.pdf': 'aa' }), answerDigest(answers, { '5:report-q5.pdf': 'aa' }));
});

test('report Markdown becomes headings, lists and tables', () => {
  const html = markdownToHtml('# 見出し\n\n本文は**強調**する。\n2行目\n\n- 一つ目\n- 二つ目\n\n| 事象 | 確率 |\n| --- | --- |\n| A | 3/10 |');
  assert.match(html, /<h2>見出し<\/h2>/);
  assert.match(html, /<p>本文は<strong>強調<\/strong>する。<br>2行目<\/p>/);
  assert.match(html, /<ul>\n<li>一つ目<\/li>/);
  assert.match(html, /<th>事象<\/th>/);
  assert.match(html, /<td>3\/10<\/td>/);
  assert.equal(markdownToHtml('<script>x</script>').includes('<script>'), false);
});

test('course contents, content selection and chapter rounds', () => {
  const html = `
    <div class="cl-contentsList_listGroupItem" data-end-date="4102444740" data-exec-count="0">
      <div class="cm-contentsList_contentName"><a href="/webclass/do_contents.php?reset_status=1&set_contents_id=${'a'.repeat(32)}">New第1回 概観 [復習課題(1)]</a></div>
      <span class="cl-contentsList_categoryLabel">自習</span>
    </div>
    <div class="cl-contentsList_listGroupItem">
      <div class="cm-contentsList_contentName"><a href="/webclass/course.php/c/contents/${'b'.repeat(32)}/">第1回 概観 [復習課題(2)]</a></div>
      <span class="cl-contentsList_categoryLabel">自習</span>
    </div>
    <div class="cl-contentsList_listGroupItem">
      <div class="cm-contentsList_contentName"><a href="/webclass/do_contents.php?set_contents_id=${'c'.repeat(32)}">講義資料</a></div>
      <span class="cl-contentsList_categoryLabel">資料</span>
    </div>`;
  const contents = extractCourseContents(html, 'course', 'ソフトウェア工学基礎');
  assert.deepEqual(contents.map((item) => [item.contentsId[0], item.category, item.title]),
    [['a', '自習', '第1回 概観 [復習課題(1)]'], ['b', '自習', '第1回 概観 [復習課題(2)]'], ['c', '資料', '講義資料']]);
  assert.equal(selectContent(contents, 'ソフトウェア工学基礎 第１回 復習課題(2)').contentsId, 'b'.repeat(32));
  assert.throws(() => selectContent(contents, '第1回'), /2件/);
  assert.throws(() => selectContent(contents, '講義資料'), /0件/);
  assert.deepEqual(roundNumbers('第2, 3回 要求定義'), [2, 3]);
  assert.deepEqual(roundNumbers('講義スライド（第１回）'), [1]);
  assert.deepEqual(roundNumbers('講義資料'), []);
});

test('chapter list decoding builds PDF URLs', () => {
  const pageUrl = '/webclass/txtbk_show_text.php?page=1&contents_url=%2Fwebclass%2Fdata%2Fcourse%2Ff2%2Fabc%2F';
  const serialized = `a:1:{i:1;a:6:{s:2:"H2";s:6:"第1回";s:4:"TEXT";s:3:"xyz";s:4:"FILE";s:9:"d/one.pdf";s:3:"url";s:${Buffer.byteLength(pageUrl)}:"${pageUrl}";}}`;
  assert.deepEqual(decodeChapterList(Buffer.from(serialized).toString('base64')), [{
    heading: '第1回', pageUrl, fileUrl: 'https://webclass.nanzan-u.ac.jp/webclass/data/course/f2/abc/d/one.pdf',
  }]);
});

test('DOCX text is extracted in paragraph order', async () => {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>第一段落</w:t></w:r></w:p><w:p><w:r><w:t>第二段落</w:t></w:r></w:p></w:body></w:document>'));
  const result = await extractAttachmentText('handout.docx', zip.toBuffer());
  assert.equal(result.supported, true);
  assert.match(result.text, /第一段落\s+第二段落/);
});

test('a task that reached submission cannot be made answerable again by answer, select or render', async () => {
  const id = 'abcdef0123456781';
  const questions = parseQuestionForm(FORM).slice(0, 3);
  const answers = [{ question: 1, values: ['a'] }, { question: 2, values: ['1'] }, { question: 3, values: ['2'] }];
  await saveJson(id, 'answer.json', { providers: ['claude'], answers });
  await saveJson(id, 'answer-claude.json', { provider: 'claude', answers, reports: [] });
  try {
    for (const status of ['submitting', 'submitted', 'unverified']) {
      await saveTask(id, { id, status, questions, fingerprint: 'x', item: { courseName: '授業', title: '課題', deadlineAt: null } });
      await assert.rejects(selectProvider(id, 'claude'), /既に提出処理/);
      await assert.rejects(generateAnswers(id, ['claude']), /既に提出処理/);
      await assert.rejects(renderReport(id), /既に提出処理/);
      await assert.rejects(approveTask(id, '0'.repeat(16)), /一致しません|既に提出処理/);
      assert.equal((await readTask(id)).status, status);
    }
  } finally {
    await rm(taskDir(id), { recursive: true, force: true });
  }
});

test('a report question stays flagged when both AIs wrote a body, since bodies cannot agree', async () => {
  const id = 'abcdef0123456782';
  const [question] = parseQuestionForm(FORM).slice(4, 5);
  const task = { id, status: 'fetched', questions: [question], item: { courseName: '通信理論', title: '第１回課題' } };
  await saveTask(id, task);
  const claude = { provider: 'claude', answers: [], reports: [{ question: 5, markdown: '答え: A' }] };
  const codex = { provider: 'codex', answers: [], reports: [{ question: 5, markdown: '答え: B' }] };
  try {
    const both = await renderReports(id, task, mergeAnswers([question], [claude, codex]), [claude, codex]);
    assert.deepEqual(both.answers[0], { question: 5, values: ['report-q5.pdf'], source: 'claude', conflict: true });
    const one = await renderReports(id, task, mergeAnswers([question], [codex]), [codex]);
    assert.equal(one.answers[0].conflict, false);
  } finally {
    await rm(taskDir(id), { recursive: true, force: true });
  }
});

test('an upload counts only when this upload changed the question, not an old 提出済', async () => {
  const [question] = parseQuestionForm(FORM).slice(4, 5);
  const frame = (text) => ({ locator: () => ({ innerText: async () => text }) });
  const paths = ['C:/tasks/x/report-q5.pdf'];
  // WebClass may store the file under another name; a changed 提出済 is accepted.
  await verifyUploaded(frame('提出済 2026/09/24 10:00 renamed.pdf'), question, paths, '提出済 2026/09/20 09:00 old.pdf');
  await verifyUploaded(frame('report-q5.pdf 提出済'), question, paths, '');
  // The 提出済 from an earlier submission, with nothing sent this time.
  await assert.rejects(verifyUploaded(frame('提出済 old.pdf'), question, paths, '提出済 old.pdf'), /変わっていない/);
  await assert.rejects(verifyUploaded(frame('ファイルを選択'), question, paths, ''), /確認できませんでした/);
  // Re-checking a page after this run's uploads only looks at the stored state.
  await verifyUploaded(frame('提出済 old.pdf'), question, paths);
});

const RECEIPT = [
  '[https://webclass.nanzan-u.ac.jp/webclass/reslt_menu.php]',
  'テスト名\t日\t得点\t得点率',
  '問\t解答\t結果\t得点/配点\t解説\t出題分野\tコメント',
  '1\ta\t○\t2/2\t\t',
  '\t',
  '2\t1\t×\t0/2\t\t',
  '3\t2\t○\t1/1\t\t',
  '成績を閉じる',
].join('\n');

test('the grade table of a submission is read from the receipt', () => {
  assert.deepEqual(parseGradeResults(RECEIPT), [
    { question: 1, answer: 'a', mark: '○', score: 2, max: 2 },
    { question: 2, answer: '1', mark: '×', score: 0, max: 2 },
    { question: 3, answer: '2', mark: '○', score: 1, max: 1 },
  ]);
  assert.deepEqual(parseGradeResults('お疲れさまでした。試験が終了しました。'), []);
});

test('retry answers only the questions marked wrong and keeps the rest of the submission', async () => {
  const id = 'abcdef0123456783';
  const questions = parseQuestionForm(FORM).slice(0, 3);
  const answers = [{ question: 1, values: ['a'] }, { question: 2, values: ['1'] }, { question: 3, values: ['2'] }];
  const solver = join(tmpdir(), `fake-claude-${process.pid}.js`);
  // Answers every question; retry must take only question 2 from it.
  await writeFile(solver, `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: JSON.stringify({
    answers: [{ question: 1, values: ['zzz'], confidence: 'high', evidence: '' },
      { question: 2, values: [process.env.FAKE_RETRY_VALUE], confidence: 'medium', evidence: '前回は甲を選んだ' }],
    reports: [], notes: '' }) })));`);
  const saved = { cli: process.env.CLAUDE_CLI_PATH, value: process.env.FAKE_RETRY_VALUE };
  process.env.CLAUDE_CLI_PATH = solver;
  const setup = async () => {
    await rm(taskDir(id), { recursive: true, force: true });
    await saveTask(id, { id, status: 'submitted', submittedAt: '2026-09-24T00:00:00Z', questions,
      fingerprint: questionFingerprint(questions), approval: { digest: 'x' },
      item: { courseName: '授業', title: '課題', deadlineAt: null } });
    await saveText(id, 'questions.md', renderQuestions(questions));
    await saveText(id, 'submission-receipt.txt', RECEIPT);
    await saveText(id, 'after-submit.png', 'png');
    await saveJson(id, 'answer.json', { providers: ['claude'], answers });
    await saveJson(id, 'answer-codex.json', { provider: 'codex', answers, reports: [] });
  };
  try {
    await setup();
    process.env.FAKE_RETRY_VALUE = '2';
    const result = await retryTask(id, { providers: ['claude'] });
    assert.deepEqual(result.targets, [2]);
    assert.deepEqual(result.repeated, []);
    const draft = await readJson(id, 'answer.json');
    assert.deepEqual(draft.answers.map((answer) => [answer.question, answer.values, answer.source]),
      [[1, ['a'], 'correct'], [2, ['2'], 'claude'], [3, ['2'], 'correct']]);
    const task = await readTask(id);
    assert.equal(task.status, 'answered');
    assert.equal(task.approval, null);
    assert.equal(task.attempts[0].results.length, 3);
    // The previous submission is kept aside, and the solver was told what was marked wrong.
    assert.equal(await readText(id, 'attempts/1/submission-receipt.txt'), RECEIPT);
    await assert.rejects(readText(id, 'submission-receipt.txt'));
    // A solver that did not run this time no longer shows its old, wrong answer.
    assert.deepEqual((await readJson(id, 'answer-codex.json')).answers.map((answer) => answer.question), [1, 3]);
    assert.equal((await readJson(id, 'attempts/1/answer-codex.json')).answers.length, 3);
    assert.match(await readText(id, 'prompt.md'), /設問2（× 0\/2点）\n前回の解答:\n {2}1\. 甲/);
    assert.match((await reviewTask(id)).markdown, /\*\*前回の解答（× 0\/2点）\*\*/);

    // Repeating the answer that was just marked wrong is flagged for the review.
    await setup();
    process.env.FAKE_RETRY_VALUE = '1';
    const again = await retryTask(id, { providers: ['claude'] });
    assert.deepEqual(again.repeated, [2]);
    assert.match((await reviewTask(id)).markdown, /設問2 ⚠ 前回不正解だった解答と同じです/);

    // Running retry again on the unsubmitted draft solves the same questions without archiving again.
    process.env.FAKE_RETRY_VALUE = '2';
    const resumed = await retryTask(id, { providers: ['claude'] });
    assert.equal(resumed.resumed, true);
    assert.deepEqual(resumed.repeated, []);
    assert.equal((await readTask(id)).attempts.length, 1);
    await assert.rejects(retryTask(id, { providers: ['claude'], questions: [3] }), /対象ではありません/);

    // Only a submitted task can be retried, and without a grade table the questions must be named.
    await saveTask(id, { ...(await readTask(id)), status: 'fetched', retry: undefined });
    await assert.rejects(retryTask(id, { providers: ['claude'] }), /提出済みの課題だけ/);
    await setup();
    await saveText(id, 'submission-receipt.txt', '試験が終了しました。');
    await assert.rejects(retryTask(id, { providers: ['claude'] }), /設問番号を指定/);
    await assert.rejects(retryTask(id, { providers: ['claude'], questions: [9] }), /存在しない設問/);
  } finally {
    for (const [key, value] of [['CLAUDE_CLI_PATH', saved.cli], ['FAKE_RETRY_VALUE', saved.value]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(solver, { force: true });
    await rm(taskDir(id), { recursive: true, force: true });
  }
});
