import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Env } from '@acct/shared';
import { ENV } from '../config/env.module';
import { AuthService, type LoginResult } from './auth.service';
import { CurrentUser, Public, TenantId } from './auth.guard';
import type { AccessTokenClaims } from './auth.service';
import { zodPipe } from '../common/zod.pipe';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
  tenantSlug: z.string().optional(),
});

const totpConfirmSchema = z.object({ code: z.string().length(6) });

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email, password and optional TOTP code' })
  async login(
    @Body(zodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<LoginResult, 'refreshToken' | 'accessToken'>> {
    const result = await this.auth.login({
      ...body,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(res, result);
    return { expiresIn: result.expiresIn, user: result.user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<LoginResult, 'refreshToken' | 'accessToken'>> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const token = cookies?.['refresh_token'] ?? '';
    const result = await this.auth.refresh(token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(res, result);
    return { expiresIn: result.expiresIn, user: result.user };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the current session' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    await this.auth.logout(cookies?.['refresh_token']);
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/api/v1/auth' });
  }

  @Get('me')
  @ApiOperation({ summary: 'The authenticated user and effective permissions' })
  me(@CurrentUser() user: AccessTokenClaims): {
    id: string;
    email: string;
    tenantId: string;
    permissions: string[];
  } {
    return { id: user.sub, email: user.email, tenantId: user.tid, permissions: user.perms };
  }

  @Post('totp/enrol')
  @ApiOperation({ summary: 'Begin TOTP enrolment; returns the secret and otpauth URL' })
  beginTotp(
    @CurrentUser() user: AccessTokenClaims,
    @TenantId() tenantId: string,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    return this.auth.beginTotpEnrolment(tenantId, user.sub, user.email);
  }

  @Post('totp/confirm')
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm TOTP enrolment with a generated code' })
  confirmTotp(
    @CurrentUser() user: AccessTokenClaims,
    @TenantId() tenantId: string,
    @Body(zodPipe(totpConfirmSchema)) body: { code: string },
  ): Promise<void> {
    return this.auth.confirmTotpEnrolment(tenantId, user.sub, body.code);
  }

  /**
   * Tokens live in httpOnly cookies so no script can read them. The refresh
   * cookie is scoped to the auth path, so it is not attached to ordinary API
   * calls and cannot leak through a mistaken log of request headers.
   */
  private setAuthCookies(res: Response, result: LoginResult): void {
    const secure = this.env.COOKIE_SECURE;
    res.cookie('access_token', result.accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: this.env.JWT_ACCESS_TTL_SECONDS * 1000,
    });
    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: this.env.JWT_REFRESH_TTL_SECONDS * 1000,
    });
  }
}
