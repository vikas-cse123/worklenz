jest.mock("../config/db", () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock("../shared/email", () => ({ sendEmail: jest.fn(), sendEmailEnhanced: jest.fn(), EmailRequest: jest.fn() }));
jest.mock("../shared/file-constants", () => ({ __esModule: true, default: { getEmailTemplate: jest.fn() } }));
jest.mock("../services/token-service", () => ({ __esModule: true, default: { generateInviteToken: jest.fn(() => "wli_personal"), createInvitation: jest.fn() } }));
jest.mock("../services/client-contacts-service", () => ({ ensureContactIdForClient: jest.fn(async () => "contact-1") }));
jest.mock("../controllers/client-portal/client-portal-base", () => ({ __esModule: true, default: class {} }));

import db from "../config/db";
import TokenService from "../services/token-service";
import Controller from "../controllers/client-portal/client-portal-auth-controller";
import { createMockRequest, createMockResponse } from "./utils/express-mock";

beforeEach(() => jest.clearAllMocks());

it("does not turn a legacy organization signup link into accounts or memberships", async () => {
  const res = createMockResponse();
  await Controller.handleOrganizationInvite(createMockRequest({ body: { token: "legacy-example" } }), res);
  expect(res.statusCode).toBe(410);
  expect(res.body.body.code).toBe("PERSONAL_INVITATION_REQUIRED");
  expect(db.query).not.toHaveBeenCalled();
});

it("does not generate new organization-wide signup links", async () => {
  const res = createMockResponse();
  await Controller.generateClientInvitationLink(createMockRequest({ body: { clientId: "organization" } }), res);
  expect(res.statusCode).toBe(410);
  expect(res.body.body.code).toBe("PERSONAL_INVITATION_REQUIRED");
  expect(db.query).not.toHaveBeenCalled();
});

it("keeps authentication required for invitation generation", async () => {
  const res = createMockResponse();
  await Controller.generateOrganizationInvitationLink(createMockRequest({ user: undefined }), res);
  expect(res.statusCode).toBe(401);
  expect(db.query).not.toHaveBeenCalled();
});

it("generates a personal OTP invitation for both staff and non-staff recipients without linking accounts early", async () => {
  (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: "client-1", email: "recipient@example.com", name: "Recipient" }] });
  const res = createMockResponse();
  await Controller.generateClientInvitationLink(createMockRequest({ body: { clientId: "client-1" } }), res);
  expect(res.body.done).toBe(true);
  expect(res.body.body.invitationLink).toContain("/invite?token=wli_personal");
  expect(res.body.body.vanityLink).toBeNull();
  expect(TokenService.createInvitation).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-1", clientContactId: "contact-1", role: "member" }));
  expect(db.query).toHaveBeenCalledTimes(1);
  expect((db.query as jest.Mock).mock.calls[0][0]).toContain("c.team_id = $2");
});
