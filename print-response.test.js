const assert = require('assert');
const { isSidExpired } = require('./print-response');

assert.strictEqual(isSidExpired({ msg: 'session_key失效' }), true);
assert.strictEqual(isSidExpired({ errcode: 1, msg: '请求失败：session_key失效，请重试' }), true);
assert.strictEqual(isSidExpired('session_key失效'), true);
assert.strictEqual(isSidExpired({ errmsg: 'session_key失效' }), true);
assert.strictEqual(isSidExpired({ msg: '其他错误' }), false);
assert.strictEqual(isSidExpired(null), false);

console.log('Print response checks passed.');
