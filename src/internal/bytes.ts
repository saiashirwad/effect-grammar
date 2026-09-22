export const nonByte = /[^\0-\xff]/

export const toBytes = (binary: string): Uint8Array => Uint8Array.from(binary, (char) => char.charCodeAt(0))

export const toText = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return binary
}

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ")
