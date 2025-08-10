module.exports = {
	 darkMode: 'class',
  content: [
    // This is the only line that matters for your project right now.
    // It tells Tailwind to scan this file for all class names.
    './index.html',
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}