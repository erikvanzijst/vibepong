import { BrowserRouter, Route, Routes } from "react-router";
import { HomePage } from "@/pages/home";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route index element={<HomePage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </BrowserRouter>
  );
}
