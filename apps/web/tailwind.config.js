/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        brand: { 50: '#fdf4ff', 100: '#fae8ff', 500: '#d946ef', 600: '#c026d3', 700: '#a21caf' },
      },
    },
  },
  plugins: [],
};
