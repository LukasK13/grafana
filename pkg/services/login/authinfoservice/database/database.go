package database

import (
	"context"
	"encoding/base64"
	"time"

	"github.com/grafana/grafana/pkg/bus"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/models"
	"github.com/grafana/grafana/pkg/services/secrets"
	"github.com/grafana/grafana/pkg/services/sqlstore"
)

var GetTime = time.Now

type AuthInfoStore struct {
	sqlStore       sqlstore.Store
	bus            bus.Bus
	secretsService secrets.Service
	logger         log.Logger
}

func ProvideAuthInfoStore(sqlStore sqlstore.Store, bus bus.Bus, secretsService secrets.Service) *AuthInfoStore {
	store := &AuthInfoStore{
		sqlStore:       sqlStore,
		bus:            bus,
		secretsService: secretsService,
		logger:         log.New("login.authinfo.store"),
	}
	store.registerBusHandlers()
	return store
}

func (s *AuthInfoStore) registerBusHandlers() {
	s.bus.AddHandler(s.GetExternalUserInfoByLogin)
	s.bus.AddHandler(s.GetAuthInfo)
	s.bus.AddHandler(s.SetAuthInfo)
	s.bus.AddHandler(s.UpdateAuthInfo)
	s.bus.AddHandler(s.DeleteAuthInfo)
}

func (s *AuthInfoStore) GetExternalUserInfoByLogin(ctx context.Context, query *models.GetExternalUserInfoByLoginQuery) error {
	userQuery := models.GetUserByLoginQuery{LoginOrEmail: query.LoginOrEmail}
	err := s.sqlStore.GetUserByLogin(ctx, &userQuery)
	if err != nil {
		return err
	}

	authInfoQuery := &models.GetAuthInfoQuery{UserId: userQuery.Result.Id}
	if err := s.GetAuthInfo(ctx, authInfoQuery); err != nil {
		return err
	}

	query.Result = &models.ExternalUserInfo{
		UserId:     userQuery.Result.Id,
		Login:      userQuery.Result.Login,
		Email:      userQuery.Result.Email,
		Name:       userQuery.Result.Name,
		IsDisabled: userQuery.Result.IsDisabled,
		AuthModule: authInfoQuery.Result.AuthModule,
		AuthId:     authInfoQuery.Result.AuthId,
	}
	return nil
}

func (s *AuthInfoStore) GetAuthInfo(ctx context.Context, query *models.GetAuthInfoQuery) error {
	if query.UserId == 0 && query.AuthId == "" {
		return models.ErrUserNotFound
	}

	userAuth := &models.UserAuth{
		UserId:     query.UserId,
		AuthModule: query.AuthModule,
		AuthId:     query.AuthId,
	}

	var has bool
	var err error

	err = s.sqlStore.WithDbSession(ctx, func(sess *sqlstore.DBSession) error {
		has, err = sess.Desc("created").Get(userAuth)
		return err
	})
	if err != nil {
		return err
	}

	if !has {
		return models.ErrUserNotFound
	}

	secretAccessToken, err := s.decodeAndDecrypt(userAuth.OAuthAccessToken)
	if err != nil {
		return err
	}
	secretRefreshToken, err := s.decodeAndDecrypt(userAuth.OAuthRefreshToken)
	if err != nil {
		return err
	}
	secretTokenType, err := s.decodeAndDecrypt(userAuth.OAuthTokenType)
	if err != nil {
		return err
	}
	secretIdToken, err := s.decodeAndDecrypt(userAuth.OAuthIdToken)
	if err != nil {
		return err
	}
	userAuth.OAuthAccessToken = secretAccessToken
	userAuth.OAuthRefreshToken = secretRefreshToken
	userAuth.OAuthTokenType = secretTokenType
	userAuth.OAuthIdToken = secretIdToken

	query.Result = userAuth
	return nil
}

func (s *AuthInfoStore) SetAuthInfo(ctx context.Context, cmd *models.SetAuthInfoCommand) error {
	authUser := &models.UserAuth{
		UserId:     cmd.UserId,
		AuthModule: cmd.AuthModule,
		AuthId:     cmd.AuthId,
		Created:    GetTime(),
	}

	if cmd.OAuthToken != nil {
		secretAccessToken, err := s.encryptAndEncode(cmd.OAuthToken.AccessToken)
		if err != nil {
			return err
		}
		secretRefreshToken, err := s.encryptAndEncode(cmd.OAuthToken.RefreshToken)
		if err != nil {
			return err
		}
		secretTokenType, err := s.encryptAndEncode(cmd.OAuthToken.TokenType)
		if err != nil {
			return err
		}

		var secretIdToken string
		if idToken, ok := cmd.OAuthToken.Extra("id_token").(string); ok && idToken != "" {
			secretIdToken, err = s.encryptAndEncode(idToken)
			if err != nil {
				return err
			}
		}

		authUser.OAuthAccessToken = secretAccessToken
		authUser.OAuthRefreshToken = secretRefreshToken
		authUser.OAuthTokenType = secretTokenType
		authUser.OAuthIdToken = secretIdToken
		authUser.OAuthExpiry = cmd.OAuthToken.Expiry
	}

	return s.sqlStore.WithTransactionalDbSession(ctx, func(sess *sqlstore.DBSession) error {
		_, err := sess.Insert(authUser)
		return err
	})
}

func (s *AuthInfoStore) UpdateAuthInfo(ctx context.Context, cmd *models.UpdateAuthInfoCommand) error {
	authUser := &models.UserAuth{
		UserId:     cmd.UserId,
		AuthModule: cmd.AuthModule,
		AuthId:     cmd.AuthId,
		Created:    GetTime(),
	}

	if cmd.OAuthToken != nil {
		secretAccessToken, err := s.encryptAndEncode(cmd.OAuthToken.AccessToken)
		if err != nil {
			return err
		}
		secretRefreshToken, err := s.encryptAndEncode(cmd.OAuthToken.RefreshToken)
		if err != nil {
			return err
		}
		secretTokenType, err := s.encryptAndEncode(cmd.OAuthToken.TokenType)
		if err != nil {
			return err
		}

		var secretIdToken string
		if idToken, ok := cmd.OAuthToken.Extra("id_token").(string); ok && idToken != "" {
			secretIdToken, err = s.encryptAndEncode(idToken)
			if err != nil {
				return err
			}
		}

		authUser.OAuthAccessToken = secretAccessToken
		authUser.OAuthRefreshToken = secretRefreshToken
		authUser.OAuthTokenType = secretTokenType
		authUser.OAuthIdToken = secretIdToken
		authUser.OAuthExpiry = cmd.OAuthToken.Expiry
	}

	cond := &models.UserAuth{
		UserId:     cmd.UserId,
		AuthModule: cmd.AuthModule,
	}

	return s.sqlStore.WithTransactionalDbSession(ctx, func(sess *sqlstore.DBSession) error {
		upd, err := sess.Update(authUser, cond)
		s.logger.Debug("Updated user_auth", "user_id", cmd.UserId, "auth_module", cmd.AuthModule, "rows", upd)
		return err
	})
}

func (s *AuthInfoStore) DeleteAuthInfo(ctx context.Context, cmd *models.DeleteAuthInfoCommand) error {
	return s.sqlStore.WithTransactionalDbSession(ctx, func(sess *sqlstore.DBSession) error {
		_, err := sess.Delete(cmd.UserAuth)
		return err
	})
}

func (s *AuthInfoStore) GetUserById(id int64) (bool, *models.User, error) {
	var (
		has bool
		err error
	)
	user := &models.User{}
	err = s.sqlStore.WithDbSession(context.Background(), func(sess *sqlstore.DBSession) error {
		has, err = sess.ID(id).Get(user)
		return err
	})
	if err != nil {
		return false, nil, err
	}

	return has, user, nil
}

func (s *AuthInfoStore) GetUser(user *models.User) (bool, error) {
	var err error
	var has bool

	err = s.sqlStore.WithDbSession(context.Background(), func(sess *sqlstore.DBSession) error {
		has, err = sess.Get(user)
		return err
	})

	return has, err
}

// decodeAndDecrypt will decode the string with the standard base64 decoder and then decrypt it
func (s *AuthInfoStore) decodeAndDecrypt(str string) (string, error) {
	// Bail out if empty string since it'll cause a segfault in Decrypt
	if str == "" {
		return "", nil
	}
	decoded, err := base64.StdEncoding.DecodeString(str)
	if err != nil {
		return "", err
	}
	decrypted, err := s.secretsService.Decrypt(context.Background(), decoded)
	if err != nil {
		return "", err
	}
	return string(decrypted), nil
}

// encryptAndEncode will encrypt a string with grafana's secretKey, and
// then encode it with the standard bas64 encoder
func (s *AuthInfoStore) encryptAndEncode(str string) (string, error) {
	encrypted, err := s.secretsService.Encrypt(context.Background(), []byte(str), secrets.WithoutScope())
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(encrypted), nil
}
