module.exports = {
	 darkMode: 'class',
  content: [
    // This is the only line that matters for your project right now.
    // It tells Tailwind to scan this file for all class names.
    './index.html',
  ],
    theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        heading: ['Space Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}