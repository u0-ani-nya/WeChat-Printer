const assert = require('assert');
const { printableText, containsUnsupportedText, unsupportedCharacters } = require('./printable-text');

const cases = [
  ['⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿº˙', '˙'],
  ['₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₔₕₖₗₘₙₚₛₜ', ''],
  ['ᵃᵇᶜᵈᵉᵍʰⁱʲᵏˡᵐⁿᵒᵖᵒ⃒ʳˢᵗᵘᵛʷˣʸᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁᵂᵞ˂˃˙*', '˙*'],
  ['ₐₔₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ᙮ᵩᵦ˪៳៷ᵨ៴ᵪᵧ', ''],
  ['㆒㆓㆔㆕㆖㆗㆘㆙㆚㆛㆜㆝㆞㆟', ''],
  ['Cₐₗₗ Mₑ\nx²-y²\n˙ * ′', 'C M\nx-y\n˙ * ′'],
  ['文字😀保留', '文字保留'],
  ['\u200Bhttps://example.com\u2060\uFEFF', 'https://example.com'],
];

for (const [input, expected] of cases) assert.strictEqual(printableText(input), expected);

const supported = '∞、。±×÷ⅠⅡⅢⅰⅱⅲ①②③⑴⑵⒈⒉㈠㈡āáǎàüΑΒΓαβγˊˋ˙*′';
assert.strictEqual(printableText(supported), supported);
assert.strictEqual(containsUnsupportedText('x²'), true);
assert.strictEqual(containsUnsupportedText(supported), false);
assert.deepStrictEqual(unsupportedCharacters('测试ᘁ ᐜ ᕽ ᙆ ᙇ ᒼ ᣳ ᒢ ᒻ ᘁ'), ['ᘁ', 'ᐜ', 'ᕽ', 'ᙆ', 'ᙇ', 'ᒼ', 'ᣳ', 'ᒢ', 'ᒻ']);
assert.deepStrictEqual(unsupportedCharacters('ᵒ⃒😀ᵒ⃒'), ['ᵒ⃒', '😀']);

console.log('Printable text compatibility checks passed.');
