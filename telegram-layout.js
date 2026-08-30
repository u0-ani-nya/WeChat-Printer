// ponytail: conservative 100-byte QR cap; raise only after this printer accepts larger values.
const TELEGRAM_QR_MAX_BYTES = 100;

function telegramQrAllowed(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8') <= TELEGRAM_QR_MAX_BYTES;
}

function telegramPrintNodes(items, separatorNodes = []) {
  return items.flatMap((item, index) => {
    const previous = items[index - 1];
    const followsMatchingMedia = previous
      && previous.userId === item.userId
      && ((previous.kind === 'image' && item.kind === 'text')
        || (previous.kind === 'text' && item.kind === 'image'));
    const nodes = followsMatchingMedia && item.continuationNodes ? item.continuationNodes : item.nodes || [];
    return index ? [...separatorNodes, ...nodes] : nodes;
  });
}

function telegramContentNodes(lines, options = {}) {
  const height = Number(options.height) === 1 ? 1 : 0;
  const width = Number(options.width) === 1 ? 1 : 0;
  return lines.map((line) => ({
    content: {
      column_align: [{ column_width: 32, style: { justification: 1 } }],
      lines: { linelist: [{ column: [line] }] },
      maxcolumn: 1,
      style: { height, justification: 1, width },
    },
  }));
}

module.exports = { telegramPrintNodes, telegramContentNodes, telegramQrAllowed };
