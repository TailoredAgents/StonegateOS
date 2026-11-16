import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMailBody } from '../../tests/e2e/support/mailhog-body.ts';

test('mail assertions decode folded quote links and UTF-8 MIME content', () => {
  const headers = {'Content-Transfer-Encoding':['quoted-printable']};
  assert.equal(decodeMailBody('Your quote: https://example.=\r\ntest/quote/token?x=3D1', headers), 'Your quote: https://example.test/quote/token?x=1');
  assert.equal(decodeMailBody('You=E2=80=99re booked!', headers), 'You’re booked!');
  assert.equal(decodeMailBody('SGVsbG8h', {'content-transfer-encoding':['base64']}), 'Hello!');
  assert.equal(decodeMailBody('Normal UTF-8: You’re booked!', {}), 'Normal UTF-8: You’re booked!');
});
