(function definePrintResponse(root, factory) {
  const response = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = response;
  if (root) root.PrinterResponse = response;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function isSidExpired(response) {
    const messages = typeof response === 'string'
      ? [response]
      : [response?.msg, response?.errmsg, response?.error];
    return messages.some((message) => typeof message === 'string' && message.includes('session_key失效'));
  }

  return { isSidExpired };
});
