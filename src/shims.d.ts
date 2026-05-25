declare module 'shapefile' {
  interface ShpSource {
    read(): Promise<{ done: boolean; value: unknown }>
  }
  export function openShp(shp: string | ArrayBuffer | Uint8Array): Promise<ShpSource>
}
