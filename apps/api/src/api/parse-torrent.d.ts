declare module 'parse-torrent' {
  interface Parsed { infoHash?: string; name?: string | string[]; length?: number }
  export default function parseTorrent(id: string | Uint8Array): Promise<Parsed>;
}
