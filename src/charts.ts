/**
 * The fixed set of charts this plugin offers. Everything is hard-coded on
 * purpose: the plugin's job is to add NOAA underwater-relief data, not to be a
 * generic chart-cache server, so there are no service-URL/zoom/bounds settings
 * for a user to get wrong.
 *
 * Two source kinds:
 *  - 'exportimage': ArcGIS ImageServer rendered per-tile by bbox (256px).
 *  - 'wmts': a 512px web-mercator tile cache; we retile each 512 tile into four
 *    native-resolution 256px XYZ tiles (z -> z+1) so detail is preserved.
 */

export type SourceDef =
  | { kind: 'exportimage'; serviceUrl: string }
  | {
      kind: 'wmts'
      base: string
      layer: string
      style: string
      format: string
    }

export interface ChartDef {
  id: string
  name: string
  description: string
  source: SourceDef
  mask: boolean // mask out land before caching/serving
  // Baked-in layer opacity (0..1) applied to each tile's alpha before caching,
  // so the layers stack sensibly without per-layer opacity tuning in Freeboard.
  // (Equivalent to setting this layer's opacity in Freeboard; leave Freeboard at
  // 100%. Changing it later requires clearing that chart's cache.)
  opacity: number
  minzoom: number
  maxzoom: number
}

const NOAA_BAG =
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/bag_hillshades_subsets/ImageServer'
const BLUETOPO_WMTS = 'https://nowcoast.noaa.gov/geoserver/gwc/service/wmts'

// Chart ids carry an `_nsNN-` prefix to control the default stacking order in
// Freeboard (users never see ids). The prefix is stripped for cache filenames
// so existing caches (e.g. noaa-sonar.mbtiles) stay valid.
export const cacheBaseName = (id: string): string => id.replace(/^_ns\d+-/, '')

export const CHARTS: ChartDef[] = [
  {
    id: '_ns01-noaa-sonar',
    name: 'NOAA Hi-Res Relief',
    description: 'NOAA high resolution underwater relief (BAG hillshade subsets)',
    source: { kind: 'exportimage', serviceUrl: NOAA_BAG },
    mask: false, // exportImage nodata is already transparent
    opacity: 0.75,
    minzoom: 1,
    maxzoom: 18
  },
  {
    id: '_ns02-bluetopo-relief',
    name: 'BlueTopo Relief',
    description: 'NOAA BlueTopo seafloor relief (hillshade), land masked',
    source: {
      kind: 'wmts',
      base: BLUETOPO_WMTS,
      layer: 'bluetopo:hillshade',
      style: '',
      format: 'image/png8'
    },
    mask: true,
    opacity: 0.5,
    minzoom: 1,
    maxzoom: 21 // BlueTopo native gridset is 512px to z20 -> 256px to z21
  },
  {
    id: '_ns03-bluetopo-bathymetry',
    name: 'BlueTopo Depth Color',
    description: 'NOAA BlueTopo colorized depth indicator, land masked',
    source: {
      kind: 'wmts',
      base: BLUETOPO_WMTS,
      layer: 'bluetopo:bathymetry',
      style: '',
      format: 'image/png8'
    },
    mask: true,
    opacity: 0.3,
    minzoom: 1,
    maxzoom: 21
  }
]
