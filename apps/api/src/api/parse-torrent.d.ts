declare module 'parse-torrent' {
  interface Parsed { infoHash?: string; name?: string | string[]; length?: number; announce?: string[]; urlList?: string[] }
  export default function parseTorrent(id: string | Uint8Array): Promise<Parsed>;
}
