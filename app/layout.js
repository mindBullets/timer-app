import "./globals.css";

export const metadata = {
  title: "UX Capstone Timer",
  description:
    "Class session timer for the AI-Native UX Capstone: run a 3-hour session from an editable agenda of timed blocks.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
