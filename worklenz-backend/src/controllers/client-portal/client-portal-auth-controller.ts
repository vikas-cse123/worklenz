import ClientPortalControllerBase from "./client-portal-base";
import { AuthenticatedClientRequest } from "../../middlewares/client-auth-middleware";
import { IWorkLenzRequest } from "../../interfaces/worklenz-request";
import { IWorkLenzResponse } from "../../interfaces/worklenz-response";
import { ServerResponse } from "../../models/server-response";
import db from "../../config/db";
import TokenService from "../../services/token-service";
import { sendEmail, sendEmailEnhanced, EmailRequest } from "../../shared/email";
import { loadClientSubject } from "../../services/client-portal-v2/subject";
import FileConstants from "../../shared/file-constants";
import { IEmailTemplateType } from "../../interfaces/email-template-type";
import { getClientPortalBaseUrl } from "../../cron_jobs/helpers";
import {
  ensureContactIdForClient,
  getLoginAccessState,
} from "../../services/client-contacts-service";

export default class ClientPortalAuthController extends ClientPortalControllerBase {
  static async validateInvitationBySlug(
    req: IWorkLenzRequest,
    res: IWorkLenzResponse,
  ) {
    try {
      const { slug } = req.params;

      if (!slug) {
        return res
          .status(400)
          .json(new ServerResponse(false, null, "Invitation slug is required"));
      }

      // Get client by invite_slug
      const clientQuery = `
        SELECT c.id, c.name, c.email, c.company_name, c.status, c.invite_slug, t.name as team_name
        FROM clients c
        JOIN teams t ON c.team_id = t.id
        WHERE LOWER(c.invite_slug) = LOWER($1) AND c.status = 'pending'
      `;
      const clientResult = await db.query(clientQuery, [slug]);

      if (clientResult.rows.length === 0) {
        return res
          .status(404)
          .json(new ServerResponse(false, null, "Invalid invitation link"));
      }

      const client = clientResult.rows[0];

      // Check if email exists in Worklenz users table
      let isExistingWorklenzUser = false;
      if (client.email) {
        const existingWorklenzUserQuery = `
          SELECT id FROM users
          WHERE LOWER(email) = LOWER($1) AND is_deleted = FALSE
        `;
        const existingWorklenzUserResult = await db.query(
          existingWorklenzUserQuery,
          [client.email],
        );
        isExistingWorklenzUser = existingWorklenzUserResult.rows.length > 0;
      }

      // Return client details for the frontend (similar to token-based invitation)
      return res.json(
        new ServerResponse(
          true,
          {
            valid: true,
            email: client.email,
            clientId: client.id,
            clientName: client.name,
            companyName: client.company_name,
            teamName: client.team_name,
            inviteSlug: client.invite_slug,
            type: "vanity_url",
            isExistingWorklenzUser,
          },
          "Invitation is valid",
        ),
      );
    } catch (error) {
      console.error("Error validating invitation by slug:", error);
      return res
        .status(500)
        .json(new ServerResponse(false, null, "Failed to validate invitation"));
    }
  }

  static async validateInvitation(
    req: IWorkLenzRequest,
    res: IWorkLenzResponse,
  ) {
    try {
      const { token } = req.query;

      if (!token) {
        return res
          .status(400)
          .json(
            new ServerResponse(false, null, "Invitation token is required"),
          );
      }

      // Get invitation details (TokenService handles both old hex and new base62 tokens)
      const invitation = await TokenService.getInvitationByToken(
        token as string,
      );

      if (!invitation) {
        return res
          .status(404)
          .json(
            new ServerResponse(false, null, "Invalid or expired invitation"),
          );
      }

      // Check if email exists in Worklenz users table
      let isExistingWorklenzUser = false;
      if (invitation.email) {
        const existingWorklenzUserQuery = `
          SELECT id FROM users
          WHERE LOWER(email) = LOWER($1) AND is_deleted = FALSE
        `;
        const existingWorklenzUserResult = await db.query(
          existingWorklenzUserQuery,
          [invitation.email],
        );
        isExistingWorklenzUser = existingWorklenzUserResult.rows.length > 0;
      }

      // Return invitation details for the frontend
      return res.json(
        new ServerResponse(
          true,
          {
            valid: true,
            email: invitation.email,
            organizationName: invitation.team_name,
            id: invitation.id,
            name: invitation.name,
            role: invitation.role,
            clientName: invitation.client_name,
            companyName: invitation.company_name,
            teamName: invitation.team_name,
            expiresAt: invitation.expires_at,
            status: invitation.status,
            type: "token",
            isExistingWorklenzUser,
          },
          "Invitation is valid",
        ),
      );
    } catch (error) {
      console.error("Error validating invitation:", error);
      return res
        .status(500)
        .json(new ServerResponse(false, null, "Failed to validate invitation"));
    }
  }

  static async refreshClientToken(
    req: IWorkLenzRequest,
    res: IWorkLenzResponse,
  ) {
    try {
      const { token } = req.body;

      if (!token) {
        return res
          .status(400)
          .json(new ServerResponse(false, null, "Token is required"));
      }

      // Verify the current token
      const decoded = TokenService.verifyClientToken(token);
      if (!decoded) {
        return res
          .status(401)
          .json(new ServerResponse(false, null, "Invalid or expired token"));
      }

      // A refresh must not outlive the user's access. Tokens issued before clientUserId was always
      // included are resolved by email so they can't be refreshed indefinitely.
      let clientUserId = decoded.clientUserId;
      if (!clientUserId) {
        const found = await db.query(
          "SELECT id FROM client_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
          [decoded.email],
        );
        clientUserId = found.rows[0]?.id;
      }

      const access = clientUserId
        ? await getLoginAccessState(db, clientUserId, decoded.clientId)
        : null;
      if (!access || !access.exists || access.loginStatus !== "active" || access.isDisabled) {
        return res
          .status(401)
          .json(new ServerResponse(false, null, "Access has been revoked"));
      }

      // Removing a company user deletes the contact but not the login, so also require that this person is
      // still an Active company user of the client the token is for. Otherwise a removed user could mint a
      // new token every day.
      const subject = await loadClientSubject(db, {
        clientUserId: clientUserId as string,
        clientId: decoded.clientId,
        teamId: decoded.organizationId,
      });
      if (!subject) {
        return res
          .status(401)
          .json(new ServerResponse(false, null, "Access has been revoked"));
      }

      // Generate new token with updated expiry
      const newToken = TokenService.generateClientToken({
        clientId: decoded.clientId,
        organizationId: decoded.organizationId,
        clientUserId,
        email: decoded.email,
        permissions: decoded.permissions || [],
        availableOrganizations: TokenService.toTokenOrganizations(
          await TokenService.getClientUserOrganizations(clientUserId as string),
        ),
        type: "client" as const,
      });

      return res.json(
        new ServerResponse(
          true,
          {
            token: newToken,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
          },
          "Token refreshed successfully",
        ),
      );
    } catch (error) {
      console.error("Error refreshing client token:", error);
      return res
        .status(401)
        .json(new ServerResponse(false, null, "Token refresh failed"));
    }
  }

  static async clientLogout(
    req: AuthenticatedClientRequest,
    res: IWorkLenzResponse,
  ) {
    try {
      // In a more complete implementation, you would invalidate the token
      // For now, we'll just return a success response
      return res.json(new ServerResponse(true, null, "Logout successful"));
    } catch (error) {
      console.error("Error during client logout:", error);
      return res
        .status(500)
        .json(new ServerResponse(false, null, "Logout failed"));
    }
  }

  static async getClientOrganizations(
    req: AuthenticatedClientRequest,
    res: IWorkLenzResponse,
  ) {
    try {
      const { clientUserId } = req as any;

      if (!clientUserId) {
        return res
          .status(400)
          .json(new ServerResponse(false, null, "Client user ID not found"));
      }

      // Get all organizations accessible by this user, flagging the one this token is acting in
      const currentTeamId = (req as any).organizationId;
      const organizations = (
        await TokenService.getClientUserOrganizations(clientUserId)
      ).map(org => ({ ...org, isCurrent: org.teamId === currentTeamId }));

      return res.json(
        new ServerResponse(
          true,
          { organizations },
          "Organizations retrieved successfully",
        ),
      );
    } catch (error) {
      console.error("Error fetching client organizations:", error);
      return res
        .status(500)
        .json(
          new ServerResponse(false, null, "Failed to retrieve organizations"),
        );
    }
  }

  static async switchOrganization(
    req: AuthenticatedClientRequest,
    res: IWorkLenzResponse,
  ) {
    try {
      const { clientUserId } = req as any;
      const { organizationId } = req.body;

      if (!clientUserId) {
        return res
          .status(400)
          .json(new ServerResponse(false, null, "Client user ID not found"));
      }

      if (!organizationId) {
        return res
          .status(400)
          .json(new ServerResponse(false, null, "Organization ID is required"));
      }

      // Get all organizations the user can currently sign in to (live, so a revoked or deactivated
      // team cannot be switched to even though the membership row still exists)
      const organizations =
        await TokenService.getClientUserOrganizations(clientUserId);
      const target = organizations.find(org => org.teamId === organizationId);

      if (!target) {
        return res
          .status(403)
          .json(
            new ServerResponse(
              false,
              null,
              "Access denied to this organization",
            ),
          );
      }

      const clientId = target.clientId;

      // Generate new token with updated organization
      const tokenPayload = {
        clientId,
        organizationId,
        clientUserId,
        email: (req as any).clientEmail || "",
        permissions: await TokenService.getClientPermissions(clientId),
        availableOrganizations: TokenService.toTokenOrganizations(organizations),
        type: "client" as const,
      };

      const newToken = TokenService.generateClientToken(tokenPayload);

      // Update last accessed timestamp
      await TokenService.updateOrganizationAccess(clientUserId, organizationId);

      return res.json(
        new ServerResponse(
          true,
          {
            token: newToken,
            organizationId,
            clientId,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
          "Organization switched successfully",
        ),
      );
    } catch (error) {
      console.error("Error switching organization:", error);
      return res
        .status(500)
        .json(new ServerResponse(false, null, "Failed to switch organization"));
    }
  }

  static async handleOrganizationInvite(
    _req: IWorkLenzRequest,
    res: IWorkLenzResponse,
  ) {
    return res.status(410).json(new ServerResponse(false, { code: "PERSONAL_INVITATION_REQUIRED" },
      "Ask your project team for a personal client invitation, or sign in to the client portal with your email code."));
  }

  static async generateClientInvitationLink(
    req: IWorkLenzRequest,
    res: IWorkLenzResponse,
  ) {
    try {
      const { clientId } = req.body;
      const userId = req.user?.id;
      const teamId = req.user?.team_id;

      if (!userId || !teamId) {
        return res
          .status(401)
          .json(new ServerResponse(false, null, "Authentication required"));
      }

      if (!clientId) {
        return res
          .status(400)
          .json(new ServerResponse(false, null, "Client ID is required"));
      }

      // Handle organization-level invite
      if (clientId === "organization") {
        return ClientPortalAuthController.generateOrganizationInvitationLink(
          req,
          res,
        );
      }

      // Get client information
      const clientQuery = `
        SELECT c.id, c.name, c.email, c.company_name, c.phone, c.contact_person, c.invite_slug
        FROM clients c
        WHERE c.id = $1 AND c.team_id = $2
      `;
      const clientResult = await db.query(clientQuery, [clientId, teamId]);

      if (!clientResult.rows.length) {
        return res
          .status(404)
          .json(new ServerResponse(false, null, "Client not found"));
      }

      const client = clientResult.rows[0];

      // Validate that client has an email address
      if (!client.email || client.email.trim() === "") {
        return res.status(400).json(
          new ServerResponse(
            false,
            {
              errorCode: "EMAIL_REQUIRED",
              clientId: client.id,
              clientName: client.name,
            },
            "Email address is required to invite the client to the portal",
          ),
        );
      }

      // Generate secure short random token for invitation (64 characters, same as team/project invitations)
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days from now
      const inviteToken = TokenService.generateInviteToken();

      // Create invitation record in database, tied to the company's contact for this email
      await TokenService.createInvitation({
        clientId: client.id,
        email: client.email,
        name: client.name,
        role: "member",
        invitedBy: userId,
        token: inviteToken,
        clientContactId: await ensureContactIdForClient(db, teamId, client),
      });

      // Generate client portal link with secure token
      const baseUrl = getClientPortalBaseUrl();
      const tokenLink = `${baseUrl}/invite?token=${inviteToken}`;

      // Company-wide vanity links cannot establish the invited recipient.
      const vanityLink = null;

      return res.json(
        new ServerResponse(
          true,
          {
            invitationLink: tokenLink,
            vanityLink: vanityLink,
            token: inviteToken,
            expiresAt: new Date(expiresAt).toISOString(),
            clientName: client.name,
            clientEmail: client.email,
            inviteSlug: client.invite_slug,
          },
          "Invitation link generated successfully",
        ),
      );
    } catch (error) {
      console.error("Error generating client invitation link:", error);
      return res
        .status(500)
        .json(
          new ServerResponse(false, null, "Failed to generate invitation link"),
        );
    }
  }

  static async resendClientInvitation(
    req: IWorkLenzRequest,
    res: IWorkLenzResponse,
  ) {
    try {
      const { id: clientId } = req.params;
      const userId = req.user?.id;
      const teamId = req.user?.team_id;
      const inviterName = req.user?.name || "Your team";

      if (!userId || !teamId) {
        return res
          .status(401)
          .json(new ServerResponse(false, null, "Authentication required"));
      }

      if (!clientId) {
        return res
          .status(400)
          .json(new ServerResponse(false, null, "Client ID is required"));
      }

      // Get client information
      const clientQuery = `
        SELECT c.id, c.name, c.email, c.company_name, c.phone, c.contact_person
        FROM clients c
        WHERE c.id = $1 AND c.team_id = $2
      `;
      const clientResult = await db.query(clientQuery, [clientId, teamId]);

      if (!clientResult.rows.length) {
        return res
          .status(404)
          .json(new ServerResponse(false, null, "Client not found"));
      }

      const client = clientResult.rows[0];
      const clientContactId = await ensureContactIdForClient(db, teamId, client);

      // Check if client already has an active portal user (already joined)
      const activeUserCheck = await db.query(
        `SELECT id FROM client_users WHERE client_id = $1 AND status = 'active'`,
        [clientId],
      );

      if (activeUserCheck.rows.length > 0) {
        return res
          .status(400)
          .json(
            new ServerResponse(
              false,
              null,
              "Client has already joined the portal",
            ),
          );
      }

      // Check if there's a pending invitation
      const pendingInviteCheck = await db.query(
        `SELECT id, email, name, token FROM client_invitations
         WHERE client_id = $1 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        [clientId],
      );

      // Generate new invitation token (short random token)
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days from now
      let inviteToken: string;

      if (pendingInviteCheck.rows.length > 0) {
        const existingInvitation = pendingInviteCheck.rows[0];
        inviteToken = TokenService.generateInviteToken();

        // Update invitation with new token, expiry, and current client email/name. created_at is
        // restarted too so "latest invitation" and the invited-at time reflect this send.
        await db.query(
          `UPDATE client_invitations
           SET token = $1, expires_at = $2, email = $3, name = $4, updated_at = NOW(),
               created_at = NOW(), client_contact_id = COALESCE(client_contact_id, $6)
           WHERE id = $5`,
          [
            inviteToken,
            new Date(expiresAt),
            client.email,
            client.name,
            existingInvitation.id,
            clientContactId,
          ],
        );
      } else {
        inviteToken = TokenService.generateInviteToken();
        // Create new invitation record
        await TokenService.createInvitation({
          clientId: client.id,
          email: client.email,
          name: client.name,
          role: "member",
          invitedBy: userId,
          token: inviteToken,
          clientContactId,
        });
      }

      // Generate invitation link
      const inviteLink = `${getClientPortalBaseUrl()}/invite?token=${inviteToken}`;

      // Get team name for email
      const teamQuery = `SELECT name FROM teams WHERE id = $1`;
      const teamResult = await db.query(teamQuery, [teamId]);
      const teamName = teamResult.rows[0]?.name || "Worklenz Team";

      // Get the email template (same as initial invitation)
      const template = FileConstants.getEmailTemplate(
        IEmailTemplateType.ClientInvitation,
      ) as string;
      if (!template) {
        return res
          .status(500)
          .json(new ServerResponse(false, null, "Email template not found"));
      }

      // Replace template variables
      const emailContent = template
        .replace(/\[VAR_CLIENT_NAME\]/g, client.name || "Client")
        .replace(/\[VAR_CLIENT_EMAIL\]/g, client.email || "")
        .replace(/\[VAR_COMPANY_NAME\]/g, client.company_name || "N/A")
        .replace(/\[VAR_CLIENT_PHONE\]/g, client.phone || "N/A")
        .replace(/\[VAR_TEAM_NAME\]/g, teamName)
        .replace(/\[VAR_PORTAL_LINK\]/g, inviteLink);

      // Send invitation email
      const emailRequest = new EmailRequest(
        [client.email],
        `Welcome to your Client Portal - ${teamName}`,
        emailContent,
      );

      const emailResult = await sendEmailEnhanced(emailRequest);

      if (!emailResult.success) {
        console.error(
          "Failed to send client invitation email:",
          emailResult.error,
        );
        const errorMessage =
          emailResult.error?.message || "Failed to send invitation email";
        return res
          .status(500)
          .json(new ServerResponse(false, null, errorMessage));
      }

      return res.json(
        new ServerResponse(
          true,
          {
            invitationLink: inviteLink,
            clientName: client.name,
            clientEmail: client.email,
            expiresAt: new Date(expiresAt).toISOString(),
            emailSent: true,
          },
          "Invitation email sent successfully",
        ),
      );
    } catch (error) {
      console.error("Error resending client invitation:", error);
      return res
        .status(500)
        .json(new ServerResponse(false, null, "Failed to resend invitation"));
    }
  }

  static async sendClientInvitationEmail(
    client: any,
    teamId: string,
    invitedBy: string,
  ) {
    try {
      // Get team information
      const teamQuery = `SELECT name FROM teams WHERE id = $1`;
      const teamResult = await db.query(teamQuery, [teamId]);
      const teamName = teamResult.rows[0]?.name || "Worklenz Team";

      // Generate secure token for invitation (short random token)
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days from now
      const inviteToken = TokenService.generateInviteToken();

      // Create invitation record in database
      await TokenService.createInvitation({
        clientId: client.id,
        email: client.email,
        name: client.name,
        role: "member",
        invitedBy,
        token: inviteToken,
        clientContactId: await ensureContactIdForClient(db, teamId, client),
      });

      // Get the email template
      const template = FileConstants.getEmailTemplate(
        IEmailTemplateType.ClientInvitation,
      ) as string;
      if (!template) {
        throw new Error("Client invitation email template not found");
      }

      // Generate client portal link with secure token
      const portalLink = `${getClientPortalBaseUrl()}/invite?token=${inviteToken}`;

      // Replace template variables
      const emailContent = template
        .replace(/\[VAR_CLIENT_NAME\]/g, client.name || "Client")
        .replace(/\[VAR_CLIENT_EMAIL\]/g, client.email || "")
        .replace(/\[VAR_COMPANY_NAME\]/g, client.company_name || "N/A")
        .replace(/\[VAR_CLIENT_PHONE\]/g, client.phone || "N/A")
        .replace(/\[VAR_TEAM_NAME\]/g, teamName)
        .replace(/\[VAR_PORTAL_LINK\]/g, portalLink);

      // Send the email
      await sendEmail({
        to: [client.email],
        subject: `Welcome to your Client Portal - ${teamName}`,
        html: emailContent,
      });
    } catch (error) {
      console.error("Error sending client invitation email:", error);
      throw error;
    }
  }

  static async generateOrganizationInvitationLink(
    req: IWorkLenzRequest,
    res: IWorkLenzResponse,
  ) {
    if (!req.user?.id || !req.user?.team_id) {
      return res.status(401).json(new ServerResponse(false, null, "Authentication required"));
    }
    return res.status(410).json(new ServerResponse(false, { code: "PERSONAL_INVITATION_REQUIRED" },
      "Invite a specific client contact using a personal invitation instead of an organization-wide signup link."));
  }
}
