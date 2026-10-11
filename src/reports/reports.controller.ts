import { UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../messaging/api-key.guard';
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { ReportsService } from './reports.service';

@UseGuards(ApiKeyGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get()
  async getReports() {
    return this.reportsService.getReports();
  }

  @Get('my')
  async getMyReports(
    @Query('platform')
    platform: string,

    @Query('platformUserId')
    platformUserId: string,
  ) {
    return this.reportsService.getUserReports(
      platform ?? '',
      platformUserId ?? '',
    );
  }

  @Get('track/:trackingCode')
  async trackReport(
    @Param('trackingCode')
    trackingCode: string,

    @Query('platform')
    platform: string,

    @Query('platformUserId')
    platformUserId: string,
  ) {
    return this.reportsService.getReportByTrackingCode(
      trackingCode,
      platform ?? '',
      platformUserId ?? '',
    );
  }

  @Post()
  async createReport(
    @Body()
    body: any,
  ) {
    const report = await this.reportsService.createReport(body);

    return {
      success: true,

      message: 'گزارش با موفقیت ثبت شد',

      trackingCode: report.trackingCode,

      report,
    };
  }

  @Post(':trackingCode/answers')
  async submitAnswers(
    @Param('trackingCode')
    trackingCode: string,

    @Body()
    body: any,
  ) {
    const result = await this.reportsService.submitAnswersAndReanalyze(
      trackingCode,
      body,
    );

    return {
      success: true,

      message: 'Answers saved and report analyzed again successfully',

      answers: result.answers,

      analysis: result.analysis,

      report: result.report,
    };
  }

  @Patch('admin/:trackingCode/status')
  async updateReportStatus(
    @Param('trackingCode')
    trackingCode: string,

    @Body()
    body: any,
  ) {
    const report = await this.reportsService.updateReportStatus(
      trackingCode,
      body.status ?? '',
      body.adminNote,
      body.finalResult,
    );

    return {
      success: true,

      message: 'Report status updated successfully',

      report,
    };
  }

  @Post('admin/:trackingCode/analyze')
  async analyzeReportWithAi(
    @Param('trackingCode')
    trackingCode: string,
  ) {
    const result = await this.reportsService.analyzeReportWithAi(trackingCode);

    return {
      success: true,

      message: 'AI analysis completed successfully',

      analysis: result.analysis,

      report: result.report,
    };
  }
}
