const assert = require('assert');
const { telegramPrintNodes, telegramContentNodes, telegramQrAllowed } = require('./telegram-layout');

const item = (userId, kind, nodes, continuationNodes) => ({ userId, kind, nodes, continuationNodes });
const image = item('1', 'image', ['name', 'image'], ['image']);
const text = item('1', 'text', ['name:text'], ['text']);
const separator = ['-----------'];

assert.deepStrictEqual(telegramPrintNodes([image, text], separator), ['name', 'image', '-----------', 'text']);
assert.deepStrictEqual(telegramPrintNodes([text, image], separator), ['name:text', '-----------', 'image']);
assert.deepStrictEqual(telegramPrintNodes([
  text,
  item('1', 'image', ['name', 'image', 'caption'], ['image', 'caption']),
], separator), ['name:text', '-----------', 'image', 'caption']);
assert.deepStrictEqual(telegramPrintNodes([
  item('1', 'image', ['first name', 'first image'], ['first image']),
  item('2', 'text', ['second name:text'], ['text']),
], separator), ['first name', 'first image', '-----------', 'second name:text']);

const contentNodes = telegramContentNodes(['first line', 'second line']);
assert.strictEqual(contentNodes.length, 2);
assert.deepStrictEqual(contentNodes.map((node) => node.content.lines.linelist), [
  [{ column: ['first line'] }],
  [{ column: ['second line'] }],
]);
assert.deepStrictEqual(contentNodes.map((node) => node.content.column_align[0].column_width), [32, 32]);
assert.strictEqual(telegramQrAllowed('x'.repeat(100)), true);
assert.strictEqual(telegramQrAllowed('x'.repeat(101)), false);
assert.strictEqual(telegramQrAllowed('https://www.xiaohongshu.com/discovery/item/6a8d4b45000000000f01dcfa?xsec_source=app_share&type=normal&xsec_token=CB7tPYdjIaH4I0a32a2C7nEGKQAYa-xNCuSAkTJI8ZHIU%3D'), false);

console.log('Telegram mixed layout checks passed.');
