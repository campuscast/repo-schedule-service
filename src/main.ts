import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { CorrelationIdInterceptor, LoggingInterceptor, AllExceptionsFilter, initTracing } from '@campuscast/shared-libs';

initTracing('schedule-service');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalInterceptors(new CorrelationIdInterceptor(), new LoggingInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  const origins = (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map(o => o.trim());
  app.enableCors({ origin: origins, credentials: true });

  const port = process.env.PORT || 3005;
  await app.listen(port);
  console.log(`[schedule-service] listening on :${port}`);
}
bootstrap();
