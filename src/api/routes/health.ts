import { Router } from "express";
import { DEFAULT_COPILOT_MODEL } from "../model-config.js";
import {
  isArchitectureImageConfigured,
  isArchitectureVisualConfigured,
} from "../architecture-visual.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/config", (_req, res) => {
  const provider = process.env.MODEL_PROVIDER === "azure" ? "azure" : "github";
  const model = process.env.MODEL_NAME || DEFAULT_COPILOT_MODEL;
  res.json({
    model,
    provider,
    architectureImageConfigured: isArchitectureImageConfigured(),
    architectureVisionConfigured: isArchitectureVisualConfigured(),
  });
});

export default router;
