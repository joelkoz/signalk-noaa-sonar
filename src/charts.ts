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
  minzoom: number
  maxzoom: number
}

const NOAA_BAG =
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/bag_hillshades_subsets/ImageServer'
const BLUETOPO_WMTS = 'https://nowcoast.noaa.gov/geoserver/gwc/service/wmts'

export const CHARTS: ChartDef[] = [
  {
    id: 'noaa-sonar',
    name: 'NOAA Hi-Res Sonar',
    description: 'NOAA high resolution bathymetric sonar (BAG hillshade subsets)',
    source: { kind: 'exportimage', serviceUrl: NOAA_BAG },
    mask: false, // exportImage nodata is already transparent
    minzoom: 1,
    maxzoom: 18
  },
  {
    id: 'bluetopo-relief',
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
    minzoom: 1,
    maxzoom: 21 // BlueTopo native gridset is 512px to z20 -> 256px to z21
  },
  {
    id: 'bluetopo-bathymetry',
    name: 'BlueTopo Bathymetry',
    description: 'NOAA BlueTopo colorized depth, land masked',
    source: {
      kind: 'wmts',
      base: BLUETOPO_WMTS,
      layer: 'bluetopo:bathymetry',
      style: '',
      format: 'image/png8'
    },
    mask: true,
    minzoom: 1,
    maxzoom: 21
  }
]
