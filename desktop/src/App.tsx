import { Navigate, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import AllTasks from "./pages/AllTasks";
import Dashboard from "./pages/Dashboard";
import EveningCheckIn from "./pages/EveningCheckIn";
import NotePage from "./pages/NotePage";
import Placeholder from "./pages/Placeholder";
import ProjectPlan from "./pages/ProjectPlan";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="tasks" element={<AllTasks />} />
        <Route path="check-in" element={<EveningCheckIn />} />
        <Route path="plan/:code" element={<ProjectPlan />} />
        <Route path="note" element={<NotePage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="emails" element={<Placeholder title="Forwarded emails" />} />
        <Route path="graph" element={<Placeholder title="Notes graph" />} />
        <Route path="people" element={<Placeholder title="People" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
