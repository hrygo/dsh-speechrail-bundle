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

  it('preserves exact audio bytes without text transcoding', () => {
    const audio = Uint8Array.from([0x00, 0xff, 0x80, 0x7f, 0x0d, 0x0a])
    const body = encodeMultipart({}, { name: 'file', filename: 'recording.wav', contentType: 'audio/wav', data: audio }, 'B')
    const start = body.indexOf('Content-Type: audio/wav\r\n\r\n') + 'Content-Type: audio/wav\r\n\r\n'.length
    expect([...body.subarray(start, start + audio.byteLength)]).toEqual([...audio])
  })
})
