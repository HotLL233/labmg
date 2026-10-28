'use strict';

const Csv = {
  cell(value) {
    let text = String(value ?? '');
    // shortcut: quoted-tab protection depends on spreadsheet software; verify new target applications.
    if (typeof value !== 'number' && (/^[\t\r\n\0]/.test(text) || /^[\s\x00-\x1f]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(text))) text = '\t' + text;
    return `"${text.replaceAll('"', '""')}"`;
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = Csv;
