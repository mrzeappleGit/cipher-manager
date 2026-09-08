import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter, Link, Outlet, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { expect, it } from "vitest";

function Frame() {
  const navigate = useNavigate();
  return <><Link to="/documents?open=brief">Documents</Link><button onClick={() => navigate(-1)}>Back</button><Outlet /></>;
}

function Session() {
  const { projectId, sessionId } = useParams();
  const [query] = useSearchParams();
  return <output aria-label="Session destination">{projectId}/{sessionId}/{query.get("msg")}</output>;
}

function Documents() {
  const [query] = useSearchParams();
  return <output aria-label="Document destination">{query.get("open")}</output>;
}

it("opens a session hash deep link, navigates with query parameters, and returns with browser history", async () => {
  const original = window.location.href;
  window.history.replaceState(null, "", "/#/projects/project%20one/sessions/session-2?msg=message%20three");
  const view = render(
    <HashRouter>
      <Routes>
        <Route element={<Frame />}>
          <Route path="/projects/:projectId/sessions/:sessionId" element={<Session />} />
          <Route path="/documents" element={<Documents />} />
        </Route>
      </Routes>
    </HashRouter>
  );
  try {
    expect(screen.getByLabelText("Session destination").textContent).toBe("project one/session-2/message three");
    fireEvent.click(screen.getByRole("link", { name: "Documents" }));
    expect(screen.getByLabelText("Document destination").textContent).toBe("brief");
    expect(window.location.hash).toBe("#/documents?open=brief");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByLabelText("Session destination").textContent).toBe("project one/session-2/message three"));
    expect(window.location.hash).toContain("?msg=message%20three");
  } finally {
    view.unmount();
    window.history.replaceState(null, "", original);
  }
});
