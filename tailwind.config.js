/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Legacy Sprint 0/1 palette — still used by pages that haven't been
      // restyled to the design spec (v1.0) yet. Remove once every page is
      // migrated to the linen/cream/dove system below.
      colors: {
        reflection: {
          50: '#f5f6fb',
          100: '#e8eaf6',
          200: '#c9cdea',
          300: '#a3aadb',
          400: '#7b81c7',
          500: '#5b5fb0',
          600: '#464a92',
          700: '#393c75',
          800: '#2f3160',
          900: '#1f2044',
        },
        linen: '#EDE8E1',
        cream: '#FAF8F5',
        dove: '#D4C8B8',
        stone: '#8A7A6A',
        charcoal: '#3A3530',
        'warm-muted': '#9E9080',
        sage: '#B5C9C1',
        medal: '#D4AF6A',
      },
      fontFamily: {
        poppins: ['Poppins', 'sans-serif'],
      },
      borderRadius: {
        card: '20px',
        'card-lg': '24px',
        island: '28px',
        pill: '20px',
        bubble: '18px',
      },
      borderWidth: {
        hair: '0.5px',
      },
    },
  },
  plugins: [],
}
