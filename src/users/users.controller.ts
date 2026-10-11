import { UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../messaging/api-key.guard';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { UsersService } from './users.service';

@UseGuards(ApiKeyGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  async findOrCreateUser(@Body() body: any) {
    const user = await this.usersService.findOrCreateUser(body);

    return {
      success: true,
      message: 'User registered successfully',
      user,
    };
  }

  @Get()
  async getUsers() {
    return this.usersService.getUsers();
  }
}
