import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeParam, decodeParam } from '../src/index.js';

test('plain ASCII value stays plain', () => {
  const result = encodeParam('filename', 'hello.txt');
  assert.deepEqual(result, [['filename', 'hello.txt']]);
});

test('non-ASCII value uses extended form', () => {
  const result = encodeParam('filename', 'caf\u00e9.txt');
  assert.equal(result.length, 1);
  assert.equal(result[0][0], 'filename*');
  assert.match(result[0][1], /^utf-8''/);
  assert.match(result[0][1], /caf%C3%A9\.txt$/);
});

test('long value is split into continuations', () => {
  const value = 'a'.repeat(200);
  const result = encodeParam('filename', value, { maxSegmentLength: 50 });
  assert.ok(result.length > 1);
  assert.equal(result[0][0], 'filename*0*');
  assert.equal(result[1][0], 'filename*1*');
  // Reassemble and decode to verify round-trip.
  const params = new Map(result);
  assert.equal(decodeParam(params, 'filename'), value);
});

test('decode plain value', () => {
  const params = new Map([['filename', 'hello.txt']]);
  assert.equal(decodeParam(params, 'filename'), 'hello.txt');
});

test('decode extended value', () => {
  const params = new Map([['filename*', "utf-8''caf%C3%A9.txt"]]);
  assert.equal(decodeParam(params, 'filename'), 'caf\u00e9.txt');
});

test('decode continuation value', () => {
  const params = new Map([
    ['filename*0*', "utf-8''caf%C3%A9"],
    ['filename*1*', '.txt'],
  ]);
  assert.equal(decodeParam(params, 'filename'), 'caf\u00e9.txt');
});

test('decode plain continuation value', () => {
  const params = new Map([
    ['filename*0', 'hello'],
    ['filename*1', '.txt'],
  ]);
  assert.equal(decodeParam(params, 'filename'), 'hello.txt');
});

test('missing parameter returns undefined', () => {
  const params = new Map();
  assert.equal(decodeParam(params, 'filename'), undefined);
});

test('malformed percent escape throws', () => {
  const params = new Map([['filename*', "utf-8''%ZZ"]]);
  assert.throws(() => decodeParam(params, 'filename'), /invalid percent escape/);
});

test('encode and decode round-trip with non-ASCII', () => {
  const value = '\u20ac rates \u2014 100%'; // euro sign, em dash, percent
  const encoded = encodeParam('title', value);
  const params = new Map(encoded);
  assert.equal(decodeParam(params, 'title'), value);
});

test('encode respects custom charset and language', () => {
  const result = encodeParam('filename', 'caf\u00e9', { charset: 'iso-8859-1', language: 'fr' });
  assert.equal(result[0][0], 'filename*');
  assert.match(result[0][1], /^iso-8859-1'fr'/);
});

test('decode extended value without charset prefix', () => {
  const params = new Map([['filename*', 'caf%C3%A9.txt']]);
  assert.equal(decodeParam(params, 'filename'), 'caf\u00e9.txt');
});

test('encode throws on empty name', () => {
  assert.throws(() => encodeParam('', 'value'), /name must be a non-empty string/);
});

test('decode throws on non-Map params', () => {
  assert.throws(() => decodeParam({}, 'filename'), /params must be a Map/);
});
