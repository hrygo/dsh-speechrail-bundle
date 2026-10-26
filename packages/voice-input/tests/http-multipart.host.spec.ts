import { describe, expect, it } from 'vitest'
import { encodeMultipart } from '../src/host/http.ts'

describe('encodeMultipart', () => {
  it('writes a canonical form-data body with the file first and closing boundary last', () => {
    const body = encodeMultipart({ response_format: 'json', model: 'm/x' }, {
      name: 'file',
      filename: 'recording.wav',
      contentType: 'audio/wav',
      data: new Uint8Array([1, 2, 3]),
    }, 'BOUNDARY').toString('latin1')

    expect(body).toBe(
      '--BOUNDARY\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n'
      + '--BOUNDARY\r\nContent-Disposition: form-data; name="model"\r\n\r\nm/x\r\n'
      + '--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\n'
      + 'Content-Type: audio/wav\r\n\r\n\u0001\u0002\u0003\r\n--BOUNDARY--\r\n',
    )
  })

  it('neutralizes a field value that tries to inject a part or a header', () => {
    const body = encodeMultipart({
      model: 'evil\"\r\nContent-Disposition: form-data; name=\"extra\"\r\n\r\npayload',
    }, { name: 'file', filename: 'recording.wav', contentType: 'audio/wav', data: new Uint8Array([1]) }, 'B').toString('latin1')

    // Exactly two parts and one closing delimiter: the injected CRLF cannot open a
    // third part, so the hostile text stays inside the value it was written into.
    expect(body.match(/--B/gu)).toHaveLength(3)
    expect(body.split('\r\n').filter((line) => line.startsWith('Content-Disposition:'))).toHaveLength(2)
    expect(body.endsWith('--B--\r\n')).toBe(true)
    expect(body).toContain('evilContent-Disposition: form-data; name=extrapayload')
  })

  it('neutralizes a filename that tries to end its own header', () => {
    const body = encodeMultipart({}, {
      name: 'file',
      filename: 'a\"\r\nX-Injected: 1\r\n\r\n',
      contentType: 'audio/wav',
      data: new Uint8Array([1]),
    }, 'B').toString('latin1')
    // The text stays inside the filename attribute instead of becoming its own header.
    expect(body.match(/Content-Type:/gu)).toHaveLength(1)
    expect(body.split('\r\n').some((line) => line.startsWith('X-Injected'))).toBe(false)
    expect(body).toContain('filename="aX-Injected: 1"')
  })

  it('preserves exact audio bytes without text transcoding', () => {
    const audio = Uint8Array.from([0x00, 0xff, 0x80, 0x7f, 0x0d, 0x0a])
    const body = encodeMultipart({}, { name: 'file', filename: 'recording.wav', contentType: 'audio/wav', data: audio }, 'B')
    const start = body.indexOf('Content-Type: audio/wav\r\n\r\n') + 'Content-Type: audio/wav\r\n\r\n'.length
    expect([...body.subarray(start, start + audio.byteLength)]).toEqual([...audio])
  })
})
