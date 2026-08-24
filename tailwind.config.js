/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
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
      },
    },
  },
  plugins: [],
}
