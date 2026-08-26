import { Font } from '@react-pdf/renderer'

// Poppins WOFF2 files (SIL Open Font License, via the @fontsource/poppins
// package) committed to public/fonts/ — react-pdf's fontkit-based engine
// reads WOFF2 directly, and bundling avoids depending on an external
// Google Fonts URL at PDF-generation time.
let registered = false

export function ensurePoppinsRegistered() {
  if (registered) return
  registered = true
  Font.register({
    family: 'Poppins',
    fonts: [
      { src: '/fonts/poppins-300.woff2', fontWeight: 300 },
      { src: '/fonts/poppins-400.woff2', fontWeight: 400 },
      { src: '/fonts/poppins-600.woff2', fontWeight: 600 },
      { src: '/fonts/poppins-700.woff2', fontWeight: 700 },
    ],
  })
}
