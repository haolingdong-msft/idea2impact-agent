import express from "express";
import cors from "cors";
import healthRoutes from "./routes/health.js";
import chatRoutes from "./routes/chat.js";
import architectureRoutes from "./routes/architecture.js";
import videoRoutes from "./routes/video.js";
import projectRoutes from "./routes/projects.js";
import slideRoutes from "./routes/slides.js";
import repositoryRoutes from "./routes/repository.js";
import githubAuthRoutes from "./routes/github-auth.js";
import outlineRoutes from "./routes/outline.js";
import speechRoutes from "./routes/speech.js";
import { authorizeProjectRequest } from "./routes/project-authorization.js";

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS?.split(",") ?? [])
  .map((o) => o.trim())
  .filter(Boolean);
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173");
}
if (allowedOrigins.length === 0) {
  console.warn("⚠ No CORS origins configured. All cross-origin requests will be rejected.");
}
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "1mb" }));
app.use(healthRoutes);
app.use(githubAuthRoutes);
app.use(authorizeProjectRequest);
app.use(projectRoutes);
app.use(repositoryRoutes);
app.use(outlineRoutes);
app.use(slideRoutes);
app.use(speechRoutes);
app.use(chatRoutes);
app.use(architectureRoutes);
app.use(videoRoutes);

if (!process.env.GITHUB_TOKEN) {
  console.warn("⚠ GITHUB_TOKEN is not set. AI endpoints will not work.");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Copilot SDK service listening on port ${PORT}`);
});
