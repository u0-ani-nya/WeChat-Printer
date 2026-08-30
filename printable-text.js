(function definePrinterTextCompatibility(root, factory) {
  const compatibility = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = compatibility;
  if (root) root.PrinterTextCompatibility = compatibility;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const UNSUPPORTED_TEXT_PATTERN = /(?:[0-9#*]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0F|\p{Emoji_Modifier})?)*|[\u00B2\u00B3\u00B9\u00BA\u02B0-\u02C3\u02E0-\u02E4\u02EA\u10FC\u1400-\u167F\u17F0-\u17F9\u18D0-\u18FF\u1D00-\u1DBF\u2070-\u209F\u2C7C\u3192-\u319F\uA69C-\uA69D\uA770\uA7F8-\uA7F9\uAB5C-\uAB5F][\u0334\u20D2]*|[\p{Cf}\uFE0F\u20E3\u0334\u20D2\p{Emoji_Modifier}])/gu;

  function printableText(value) {
    return String(value ?? '').replace(UNSUPPORTED_TEXT_PATTERN, '');
  }

  function containsUnsupportedText(value) {
    return printableText(value) !== String(value ?? '');
  }

  function unsupportedCharacters(value) {
    return [...new Set(String(value ?? '').match(UNSUPPORTED_TEXT_PATTERN) || [])];
  }

  return { printableText, containsUnsupportedText, unsupportedCharacters };
});
