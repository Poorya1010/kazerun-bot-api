import { ReportsController } from './reports.controller';

describe('ReportsController', () => {
  it('passes caller identity to private tracking lookup', async () => {
    const service: any = {
      getReportByTrackingCode: jest
        .fn()
        .mockResolvedValue({ trackingCode: 'KZ-test' }),
    };
    const controller = new ReportsController(service);
    await controller.trackReport('KZ-test', 'rubika', 'user-guid');
    expect(service.getReportByTrackingCode).toHaveBeenCalledWith(
      'KZ-test',
      'rubika',
      'user-guid',
    );
  });
});
