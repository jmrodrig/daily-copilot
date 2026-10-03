import { Navigate, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import EveningCheckIn from "./pages/EveningCheckIn";
import Placeholder from "./pages/Placeholder";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="check-in" element={<EveningCheckIn />} />
        <Route path="projects" element={<Placeholder title="Projects" />} />
        <Route path="knowledge" element={<Placeholder title="Knowledge Base" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
